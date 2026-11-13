import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationV2ThreadShell,
  type ScheduledTaskMutationResult,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OverviewService from "./OverviewService.ts";

const project = { id: ProjectId.make("project:overview"), defaultModelSelection: null };

const makeLayer = Effect.fn("makeOverviewTestLayer")(function* () {
  const launched = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
  const archived = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const tasks = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
  const deletedTaskThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const layer = OverviewService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: "/home/user/.t3",
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: (input) =>
            Effect.succeed({
              project: { ...project, workspaceRoot: input.workspaceRoot },
              created: true,
            } as unknown as Effect.Success<
              ReturnType<ProjectService.ProjectService["Service"]["bootstrap"]>
            >),
          getById: () => Effect.succeedNone,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Ref.get(archived).pipe(
              Effect.map(
                (archivedIds) =>
                  ({
                    id: threadId,
                    deletedAt: null,
                    archivedAt: archivedIds.has(threadId) ? "2026-11-13T00:00:00.000Z" : null,
                  }) as unknown as OrchestrationV2ThreadShell,
              ),
            ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.updateAndGet(launched, (all) => [...all, input]).pipe(
              Effect.map(
                (all) =>
                  ({
                    threadId: ThreadId.make(`thread:overview-${all.length}`),
                  }) as ThreadLaunchService.ThreadLaunchResult,
              ),
            ),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          upsert: (input) =>
            Ref.update(tasks, (all) => [...all, input]).pipe(
              Effect.as({} as ScheduledTaskMutationResult),
            ),
          deleteForThread: (threadId) =>
            Ref.update(deletedTaskThreads, (all) => [...all, threadId]),
        }),
      ),
    ),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, launched, archived, tasks, deletedTaskThreads };
});

it.effect("starts one overview thread, and a fresh one once it is archived", () =>
  Effect.gen(function* () {
    const harness = yield* makeLayer();
    yield* Effect.gen(function* () {
      const overview = yield* OverviewService.OverviewService;
      const settings = yield* ServerSettings.ServerSettingsService;

      const first = yield* overview.start({});
      assert.deepEqual(yield* overview.start({}), first);
      assert.equal((yield* settings.getSettings).overviewThreadId, first.threadId);
      const [launch] = yield* Ref.get(harness.launched);
      assert.equal(launch?.initialMessage?.text, OverviewService.OVERVIEW_BRIEF);
      assert.deepInclude((yield* Ref.get(harness.tasks))[0], {
        threadId: first.threadId,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });

      yield* Ref.set(harness.archived, new Set([first.threadId]));
      const second = yield* overview.start({});
      assert.notEqual(second.threadId, first.threadId);
      assert.equal((yield* settings.getSettings).overviewThreadId, second.threadId);
      assert.lengthOf(yield* Ref.get(harness.launched), 2);
      assert.deepEqual(yield* Ref.get(harness.deletedTaskThreads), [first.threadId]);
    }).pipe(Effect.provide(harness.layer));
  }),
);
