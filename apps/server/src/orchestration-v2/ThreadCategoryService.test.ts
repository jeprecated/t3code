import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadCategory,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCategoryService from "./ThreadCategoryService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:categories");
const threadId = ThreadId.make("thread:categories");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in category tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const category = (id: string, name: string, repositories: string[] = []): ThreadCategory => ({
  id,
  name,
  description: "",
  color: "teal",
  rules:
    repositories.length === 0
      ? []
      : [
          {
            repositories,
            environments: [],
            providerInstances: [],
            branches: [],
            workspacePaths: [],
          },
        ],
});

const categories = [
  category("t3", "T3 Code", ["github.com/pingdotgg/t3code"]),
  category("mobile", "Mobile"),
  category("gpt", "GPT Live"),
  category("self", "Self Deprecated"),
];

function makeLayer(
  generateThreadCategories: TextGeneration.TextGeneration["Service"]["generateThreadCategories"],
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-categories" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({ threadCategories: categories });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requested) =>
      Effect.succeed(
        requested === projectId
          ? Option.some({
              projectId,
              title: "t3code",
              workspaceRoot: "/src/t3code",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  return Layer.mergeAll(
    layerThreadManagement,
    ThreadCategoryService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerThreadManagement,
          layerProjects,
          layerServerSettings,
          Layer.mock(TextGeneration.TextGeneration)({ generateThreadCategories }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/pingdotgg/t3code",
                locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
              }),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("lattice")),
          }),
        ),
      ),
    ),
    layerDatabase,
  );
}

const createThread = (messages: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId,
      title: "New thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const [index, text] of messages.entries()) {
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`message:${index}`),
        threadId,
        messageId: MessageId.make(`message:${index}`),
        text,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
    }
  });

const storedThread = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return (yield* threads.getThreadRecords(threadId, [])).thread;
});

describe("ThreadCategoryService", () => {
  it.effect("suggests only categories the thread lacks and stores the answer on it", () => {
    const generate = vi.fn<TextGeneration.TextGeneration["Service"]["generateThreadCategories"]>(
      () => Effect.succeed({ categoryIds: ["mobile", "gpt", "t3"] }),
    );
    return Effect.gen(function* () {
      yield* createThread(["Add GPT Live voice mode to the BodyDiff iOS app"]);
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.categories.update",
        commandId: CommandId.make("dismiss-self"),
        threadId,
        changes: [{ categoryId: "self", state: "exclude" }],
      });
      const service = yield* ThreadCategoryService.ThreadCategoryService;

      // T3 Code was never offered (the rule already gives it), so it is dropped.
      assert.deepEqual((yield* service.suggest(threadId)).suggested, ["mobile", "gpt"]);
      const request = generate.mock.calls[0]![0];
      assert.deepEqual(
        request.categories.map((entry) => entry.id),
        ["mobile", "gpt"],
      );
      assert.deepEqual(request.currentCategoryNames, ["T3 Code"]);
      assert.include(request.conversation, "BodyDiff iOS app");

      const thread = yield* storedThread;
      assert.deepEqual(thread.categories?.suggested, ["mobile", "gpt"]);
      assert.equal(thread.categories?.reviewedMessageCount, 1);

      // A pending suggestion is returned as is, without asking again.
      assert.deepEqual((yield* service.suggest(threadId)).suggested, ["mobile", "gpt"]);
      assert.equal(generate.mock.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(generate)));
  });

  it.effect("asks once for concurrent requests and not again until the thread grows", () => {
    let release: Deferred.Deferred<void> | undefined;
    const generate = vi.fn<TextGeneration.TextGeneration["Service"]["generateThreadCategories"]>(
      () => Deferred.await(release!).pipe(Effect.as({ categoryIds: [] as ReadonlyArray<string> })),
    );
    return Effect.gen(function* () {
      release = yield* Deferred.make<void>();
      yield* createThread(["Plan the Skool launch video for next week"]);
      const service = yield* ThreadCategoryService.ThreadCategoryService;
      const first = yield* Effect.forkChild(service.suggest(threadId));
      yield* Effect.yieldNow;
      assert.deepEqual((yield* service.suggest(threadId)).suggested, []);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      assert.equal(generate.mock.calls.length, 1);
      assert.equal((yield* storedThread).categories?.reviewedMessageCount, 1);

      yield* service.suggest(threadId);
      assert.equal(generate.mock.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(generate)));
  });

  it.effect("tags by name, removes rule-given categories for the thread, and keeps updatedAt", () =>
    Effect.gen(function* () {
      yield* createThread([]);
      const before = yield* storedThread;
      const service = yield* ThreadCategoryService.ThreadCategoryService;
      const result = yield* service.update({
        threadId,
        commandId: CommandId.make("tag"),
        add: ["gpt live", "mobile"],
        remove: ["T3 Code"],
      });
      assert.deepEqual(result.categoryIds, ["mobile", "gpt"]);

      const after = yield* storedThread;
      assert.deepEqual(after.categories, {
        included: ["gpt", "mobile"],
        excluded: ["t3"],
        suggested: [],
        dismissed: [],
        reviewedMessageCount: 0,
      });
      assert.deepEqual(after.updatedAt, before.updatedAt);
      const threads = yield* ThreadManagement.ThreadManagementService;
      assert.deepEqual((yield* threads.getThreadShell(threadId))?.categories, after.categories);
      assert.deepEqual((yield* service.membership(threadId)).categoryIds, ["mobile", "gpt"]);

      const unknown = yield* service
        .update({ threadId, commandId: CommandId.make("unknown"), add: ["Infra"], remove: [] })
        .pipe(Effect.flip);
      assert.equal(unknown._tag, "ThreadCategoryNotFoundError");
    }).pipe(Effect.provide(makeLayer(() => Effect.die("no suggestions in this test")))),
  );
});
