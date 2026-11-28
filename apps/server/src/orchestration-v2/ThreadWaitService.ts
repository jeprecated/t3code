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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TaskSnoozeService from "../taskSnoozes/TaskSnoozeService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadWaitService extends Context.Service<
  ThreadWaitService,
  {
    /**
     * Drops the thread's waits that `answers` name and, unless `wake` is false, tells its agent
     * in one message. Fails only when none of them is still current.
     */
    readonly resolve: (
      input: ThreadWaitResolveInput & { readonly resolvedBy: "user" | "agent" },
    ) => Effect.Effect<ThreadWaitResolveResult, ThreadWaitNotFoundError | ThreadWaitResolveError>;
  }
>()("t3/orchestration-v2/ThreadWaitService") {}

/** Reads as the user's reply to each wait, since the thread shows it as a message from them. */
function wakeText(
  answers: ReadonlyArray<{ readonly summary: string; readonly note?: string | undefined }>,
  resolvedBy: "user" | "agent",
): string {
  const replies = answers.map(
    (answer) => `> ${answer.summary.replaceAll("\n", " ")}\n\n${answer.note?.trim() || "Done."}`,
  );
  if (resolvedBy === "agent") replies.push("(via the overview agent)");
  return replies.join("\n\n");
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const snoozes = yield* TaskSnoozeService.TaskSnoozeService;

  const resolve: ThreadWaitService["Service"]["resolve"] = Effect.fn("ThreadWaitService.resolve")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        threadId: input.threadId,
        waitIds: input.answers.map((answer) => answer.waitId).join(","),
      });
      const failed = (stage: "resolve" | "wake") => (cause: unknown) =>
        new ThreadWaitResolveError({ threadId: input.threadId, stage, cause });
      const before = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(failed("resolve")));
      // The shell applies `currentThreadWaiting`, so a wait the user already answered is gone.
      const current = before?.deletedAt === null ? (before.waiting?.items ?? []) : [];
      const answers = input.answers.flatMap((answer) => {
        const wait = current.find((item) => item.id === answer.waitId);
        return wait === undefined ? [] : [{ ...answer, summary: wait.summary }];
      });
      if (before == null || answers.length === 0) {
        return yield* new ThreadWaitNotFoundError({
          threadId: input.threadId,
          waitId: input.answers[0].waitId,
        });
      }
      const uuid = yield* random.uuidV4().pipe(Effect.orDie);
      for (const answer of answers) {
        yield* orchestrator
          .dispatch({
            type: "thread.waiting.resolve",
            commandId: CommandId.make(
              `server:wait-resolve:${input.threadId}:${uuid}:${answer.waitId}`,
            ),
            threadId: input.threadId,
            waitId: answer.waitId,
          })
          .pipe(Effect.mapError(failed("resolve")));
        // The wait is gone either way, so a stale snooze only costs a dead row.
        yield* snoozes
          .clear({ key: taskWaitKey(input.threadId, answer.waitId) })
          .pipe(Effect.ignore({ log: true }));
      }
      if (input.wake !== false) {
        yield* threads
          .sendToThread({
            projectId: before.projectId,
            commandId: CommandId.make(`server:wait-resolve-wake:${input.threadId}:${uuid}`),
            threadId: input.threadId,
            messageId: MessageId.make(`wait-resolve:${input.threadId}:${uuid}`),
            text: wakeText(answers, input.resolvedBy),
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
