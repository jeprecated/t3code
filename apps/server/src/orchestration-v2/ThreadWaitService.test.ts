import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadWaitService from "./ThreadWaitService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for waits"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-waits" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

type SendInput = ThreadManagementService.ThreadManagementSendInput;

/** Sends dispatch the message as given, without starting a provider turn. */
const layerTest = (sent: Ref.Ref<ReadonlyArray<SendInput>>) =>
  ThreadWaitService.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.update(sent, (all) => [...all, input]).pipe(
                Effect.andThen(
                  orchestrator.dispatch({
                    type: "message.dispatch",
                    commandId: input.commandId,
                    threadId: input.threadId,
                    messageId: input.messageId,
                    text: input.text,
                    attachments: [],
                    dispatchMode: { type: "defer_start" },
                    createdBy: input.createdBy,
                    creationSource: input.creationSource,
                  }),
                ),
                Effect.orDie,
                // ThreadWaitService does not read the send result.
                Effect.as({} as ThreadManagementService.ThreadManagementSendResult),
              ),
          });
        }),
      ),
    ),
    Layer.provideMerge(layerOrchestrator),
    Layer.provide(NodeCrypto.layer),
  );

it.effect("resolves one wait, wakes the thread as T3, and leaves its other waits current", () =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<SendInput>>([]);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const waits = yield* ThreadWaitService.ThreadWaitService;
      const threadId = ThreadId.make("thread:wait-service");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-wait-service"),
        threadId,
        projectId: ProjectId.make("project:wait-service"),
        title: "Waits",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const step = { id: "switch", kind: "manual_step" as const, summary: "Run nix switch." };
      const decision = { id: "pick", kind: "decision" as const, summary: "Pick A or B." };
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.waiting.set",
        commandId: CommandId.make("set-wait-service"),
        threadId,
        items: [step, decision],
      });
      yield* TestClock.adjust("1 second");

      const result = yield* waits.resolve({
        threadId,
        waitId: "switch",
        note: "Done on Lattice",
        resolvedBy: "agent",
      });
      assert.deepEqual(result.waiting?.items, [decision]);
      const [wake] = yield* Ref.get(sent);
      assert.notEqual(wake?.createdBy, "user");
      assert.equal(wake?.mode, "auto");
      assert.include(
        wake?.text,
        '"Run nix switch." (switch) via the overview agent: Done on Lattice',
      );
      // The wake is in the thread now, and the decision still stands.
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.waiting?.items, [decision]);

      const missing = yield* waits
        .resolve({ threadId, waitId: "switch", resolvedBy: "user" })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "ThreadWaitNotFoundError");
      yield* waits.resolve({ threadId, waitId: "pick", resolvedBy: "user", wake: false });
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.waiting ?? null);
      assert.lengthOf(yield* Ref.get(sent), 1);
    }).pipe(Effect.provide(layerTest(sent)));
  }),
);
