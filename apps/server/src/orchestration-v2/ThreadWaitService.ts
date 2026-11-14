import {
  CommandId,
  MessageId,
  taskWaitKey,
  ThreadWaitNotFoundError,
  ThreadWaitResolveError,
  type ThreadWaitResolveInput,
  type ThreadWaitResolveResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TaskSnoozeService from "../taskSnoozes/TaskSnoozeService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadWaitService extends Context.Service<
  ThreadWaitService,
  {
    /** Drops one current wait and, unless `wake` is false, tells the thread's agent. */
    readonly resolve: (
      input: ThreadWaitResolveInput & { readonly resolvedBy: "user" | "agent" },
    ) => Effect.Effect<ThreadWaitResolveResult, ThreadWaitNotFoundError | ThreadWaitResolveError>;
  }
>()("t3/orchestration-v2/ThreadWaitService") {}

function wakeText(input: {
  readonly summary: string;
  readonly waitId: string;
  readonly note?: string | undefined;
  readonly resolvedBy: "user" | "agent";
}): string {
  const via = input.resolvedBy === "agent" ? " via the overview agent" : "";
  const note = input.note === undefined ? "" : `: ${input.note}`;
  return `The user resolved "${input.summary}" (${input.waitId})${via}${note}. Continue with what this unblocks, then call set_waiting with whatever is still open, or [].`;
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const snoozes = yield* TaskSnoozeService.TaskSnoozeService;

  const resolve: ThreadWaitService["Service"]["resolve"] = Effect.fn("ThreadWaitService.resolve")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ threadId: input.threadId, waitId: input.waitId });
      const failed = (stage: "resolve" | "wake") => (cause: unknown) =>
        new ThreadWaitResolveError({ threadId: input.threadId, stage, cause });
      const before = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(failed("resolve")));
      // The shell applies `currentThreadWaiting`, so a wait the user already answered is gone.
      const wait = before?.waiting?.items.find((item) => item.id === input.waitId);
      if (before == null || before.deletedAt !== null || wait === undefined) {
        return yield* new ThreadWaitNotFoundError({
          threadId: input.threadId,
          waitId: input.waitId,
        });
      }
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* orchestrator
        .dispatch({
          type: "thread.waiting.resolve",
          commandId: CommandId.make(`server:wait-resolve:${input.threadId}:${uuid}`),
          threadId: input.threadId,
          waitId: input.waitId,
        })
        .pipe(Effect.mapError(failed("resolve")));
      // The wait is gone either way, so a stale snooze only costs a dead row.
      yield* snoozes
        .clear({ key: taskWaitKey(input.threadId, input.waitId) })
        .pipe(Effect.ignore({ log: true }));
      if (input.wake !== false) {
        yield* threads
          .sendToThread({
            projectId: before.projectId,
            commandId: CommandId.make(`server:wait-resolve-wake:${input.threadId}:${uuid}`),
            threadId: input.threadId,
            messageId: MessageId.make(`wait-resolve:${input.threadId}:${uuid}`),
            text: wakeText({
              summary: wait.summary,
              waitId: input.waitId,
              note: input.note,
              resolvedBy: input.resolvedBy,
            }),
            attachments: [],
            mode: "auto",
            // Not "user": a user-authored message would clear the thread's other waits.
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError(failed("wake")));
      }
      const after = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(failed("resolve")));
      return { waiting: after?.waiting ?? null };
    },
  );

  return ThreadWaitService.of({ resolve });
});

export const layer = Layer.effect(ThreadWaitService, make);
