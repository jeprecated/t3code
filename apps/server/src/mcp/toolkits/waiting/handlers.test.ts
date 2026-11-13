import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadWaiting,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadWaitService from "../../../orchestration-v2/ThreadWaitService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WaitingHandlers from "./handlers.ts";
import { WaitingToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const SET_AT = "2026-11-02T00:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeWaitingToolkitHarness")(function* (
  lineage?: OrchestrationV2ThreadShell["lineage"],
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const resolved = yield* Ref.make<
    ReadonlyArray<Parameters<ThreadWaitService.ThreadWaitService["Service"]["resolve"]>[0]>
  >([]);
  const waiting = yield* Ref.make<OrchestrationV2ThreadWaiting | null>(null);
  const shell = (id: ThreadId) =>
    Effect.map(Ref.get(waiting), (current) => ({
      ...McpToolAccessTestkit.liveThreadShell(id),
      ...(lineage === undefined ? {} : { lineage }),
      waiting: current,
    }));
  const layerDependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => (id === THREAD_ID ? shell(id) : Effect.succeed(null)),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (recorded) => [...recorded, command]);
          if (command.type === "thread.waiting.set") {
            yield* Ref.set(
              waiting,
              command.items.length === 0 ? null : { items: command.items, setAt: SET_AT },
            );
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ThreadWaitService.ThreadWaitService)({
      resolve: (input) =>
        Ref.update(resolved, (all) => [...all, input]).pipe(Effect.as({ waiting: null })),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* WaitingToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WaitingHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const handle = <Name extends keyof typeof WaitingToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof WaitingToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  const call = (
    params: Parameters<typeof toolkit.handle<"set_waiting">>[1],
    capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
  ) => handle("set_waiting", params, capabilities);
  return { commands, resolved, call, handle };
});

describe("waiting toolkit handlers", () => {
  it.effect("replaces the token's thread's waits with the full list, and [] clears them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const decision = {
        id: "pick",
        kind: "decision" as const,
        summary: "Pick A or B.",
        options: ["A", "B"],
      };
      const step = {
        id: "posthog",
        kind: "manual_step" as const,
        summary: "Create a PostHog account.",
        where: "browser with my logins",
      };

      expect(yield* harness.call({ waits: [decision, step] })).toEqual({
        waiting: { items: [decision, step], setAt: SET_AT },
      });
      expect(yield* harness.call({ waits: [] })).toEqual({ waiting: null });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.waiting.set", threadId: THREAD_ID, items: [decision, step] },
        { type: "thread.waiting.set", threadId: THREAD_ID, items: [] },
      ]);
    }),
  );

  it.effect("refuses a subagent thread, an unknown thread, and a token without orchestration", () =>
    Effect.gen(function* () {
      const waits = [{ id: "vendor", kind: "blocked" as const, summary: "Waiting on the vendor." }];
      const child = yield* makeHarness({
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      });
      expect(yield* child.call({ waits }).pipe(Effect.flip)).toMatchObject({
        _tag: "WaitingFromSubagentError",
      });
      expect(yield* Ref.get(child.commands)).toEqual([]);

      const harness = yield* makeHarness();
      expect(
        yield* harness.call({ threadId: ThreadId.make("missing"), waits }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "WaitingThreadNotFoundError", threadId: "missing" });
      expect(yield* harness.call({ waits }, ["preview"]).pipe(Effect.flip)).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "orchestration",
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("rejects two waits with one id before setting anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const wait = { id: "pick", kind: "decision" as const, summary: "Pick A or B." };
      expect(
        yield* harness
          .call({ waits: [wait, { ...wait, summary: "Pick C or D." }] })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "WaitingDuplicateIdError", waitId: "pick" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("resolves a wait on the named thread as the agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.handle("resolve_wait", {
          threadId: THREAD_ID,
          waitId: "pick",
          note: "The user picked A.",
        }),
      ).toEqual({ waiting: null });
      expect(yield* Ref.get(harness.resolved)).toEqual([
        { threadId: THREAD_ID, waitId: "pick", note: "The user picked A.", resolvedBy: "agent" },
      ]);
      expect(
        yield* harness
          .handle("resolve_wait", { threadId: THREAD_ID, waitId: "pick" }, ["preview"])
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      expect(yield* Ref.get(harness.resolved)).toHaveLength(1);
    }),
  );
});
