import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  WaitingFromSubagentError,
  WaitingSetFailedError,
  WaitingThreadNotFoundError,
  WaitingThreadRequiredError,
  WaitingToolkit,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;

  const requireThread = Effect.fn("WaitingToolkit.requireThread")(function* (
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new WaitingThreadRequiredError();
    }
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new WaitingSetFailedError({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new WaitingThreadNotFoundError({ threadId });
    }
    return thread;
  });

  return {
    set_waiting: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const thread = yield* requireThread(input.threadId);
          if (thread.lineage.relationshipToParent === "subagent") {
            return yield* new WaitingFromSubagentError();
          }
          const uuid = yield* random.uuidV4().pipe(Effect.orDie);
          yield* engine
            .dispatch({
              type: "thread.waiting.set",
              commandId: CommandId.make(`server:mcp-waiting-set:${thread.id}:${uuid}`),
              threadId: thread.id,
              items: input.waits,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(new WaitingSetFailedError({ cause })),
              ),
            );
          const after = yield* requireThread(thread.id);
          return { waiting: after.waiting ?? null };
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof WaitingToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(WaitingToolkit, make);
