import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  OverviewStartError,
  type OverviewStartInput,
  type OverviewStartResult,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The overview thread's first message. Model-facing: see evals/README.md before changing it. */
export const OVERVIEW_BRIEF = `You are the user's overview agent in T3 Code. You keep their queue honest: what agents in all their threads, here and in linked environments, wait on from them, plus their own todos.

Where to look: t3_thread_list with waiting: true (each wait has an id, kind, where and notBefore), t3_pending_request for questions agents asked, t3_thread_list for threads that failed or handed work back, and user_todos. Pass environmentId to reach a linked environment.

- When the user says they did something, find every wait it resolves, in any thread or environment, and call resolve_wait on each with a short note. That wakes the thread. Leave waits it does not match; ask when unsure.
- When asked to sweep, and every morning, read threads that ended recently with no waits recorded. Where the agent asked the user for something, record it with set_waiting and that threadId; where it finished something worth the user's judgement, record a review wait. Never invent asks.
- Manage the user's own todos with user_todos when they ask.
- Answer "what's waiting?", "what can I do from my phone?" or "what can I do at my desk?" from each wait's kind, where and notBefore, and the todos.

Be brief. Lead with what unblocks the most idle agents. One line per item, with its thread title.

Morning sweep reply, in this order:
1. How many things wait on the user, and the longest wait.
2. Quick ones first: decisions they can answer now.
3. Asks you newly recorded.
4. Later today: items whose notBefore is later today.
5. Not here: items that need a place or device.

For now, reply only: Ready.`;

const MORNING_SWEEP_PROMPT =
  "Morning sweep: check every thread and linked environment for what waits on me, record asks from recently ended threads that have no waits, and reply in the morning sweep format.";

export class OverviewService extends Context.Service<
  OverviewService,
  {
    /** Returns the overview thread, creating it, its project and its morning sweep when none is live. */
    readonly start: (
      input: OverviewStartInput,
    ) => Effect.Effect<OverviewStartResult, OverviewStartError>;
  }
>()("t3/overview/OverviewService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  // Two clients starting at once must not make two overview threads.
  const starting = yield* Semaphore.make(1);

  const fail = (stage: OverviewStartError["stage"]) => (cause: unknown) =>
    new OverviewStartError({ stage, cause });
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

  const isLive = Effect.fn("OverviewService.isLive")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(fail("thread")));
    return shell != null && shell.deletedAt === null && shell.archivedAt === null;
  });

  const overviewProject = Effect.fn("OverviewService.overviewProject")(function* (
    projectId: ProjectId | undefined,
  ) {
    if (projectId !== undefined) {
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail("project")));
      if (Option.isSome(project)) return project.value;
      return yield* fail("project")(`Project ${projectId} was not found.`);
    }
    const uuid = yield* newId;
    const { project } = yield* projects
      .bootstrap({
        commandId: CommandId.make(`server:overview-project:${uuid}`),
        projectId: ProjectId.make(uuid),
        title: "Overview",
        workspaceRoot: path.join(config.baseDir, "overview"),
        createWorkspaceRootIfMissing: true,
      })
      .pipe(Effect.mapError(fail("project")));
    return project;
  });

  const start: OverviewService["Service"]["start"] = Effect.fn("OverviewService.start")(
    function* (input) {
      const current = yield* settings.getSettings.pipe(Effect.mapError(fail("settings")));
      const previous = current.overviewThreadId;
      if (previous !== null && (yield* isLive(previous))) return { threadId: previous };

      const project = yield* overviewProject(input.projectId);
      const resolved = resolveProjectSettings(current, project.id, project).settings;
      const modelSelection = input.modelSelection ??
        resolved.defaultModelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        };
      const uuid = yield* newId;
      const { threadId } = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`server:overview-thread:${uuid}`),
          projectId: project.id,
          title: "Overview",
          modelSelection,
          runtimeMode: resolved.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: OVERVIEW_BRIEF, attachments: [] },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail("thread")));
      yield* settings
        .updateSettings({ overviewThreadId: threadId })
        .pipe(Effect.mapError(fail("settings")));

      // The old thread's sweep would keep running into an archived thread.
      if (previous !== null) {
        yield* scheduledTasks.deleteForThread(previous).pipe(Effect.mapError(fail("schedule")));
      }
      yield* scheduledTasks
        .upsert({
          title: "Morning sweep",
          prompt: MORNING_SWEEP_PROMPT,
          enabled: true,
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
          projectId: project.id,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: resolved.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail("schedule")));
      return { threadId };
    },
    (effect) => starting.withPermits(1)(effect),
  );

  return OverviewService.of({ start });
});

export const layer = Layer.effect(OverviewService, make);
