import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TaskKey, UserTodo } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { getClientSettings } from "./hooks/useSettings";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";
import { formatUpcomingTimestamp } from "./timestampFormat";

/** Reverses an outcome; the cockpit's Undo key and the toast's button both call it. */
export type UndoOutcome = () => void;

function failed(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return true;
}

/** Shows `title` with Undo, and gives the cockpit the same Undo. */
function withUndo(title: string, undo: () => Promise<void>): UndoOutcome {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    toastManager.close(toastId);
    void undo();
  };
  const toastId = toastManager.add({
    type: "success",
    title,
    actionProps: { children: "Undo", onClick: run },
  });
  return run;
}

export async function clearTaskSnooze(environmentId: EnvironmentId, key: TaskKey) {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.clearTaskSnooze,
    { environmentId, input: { key } },
    { reportFailure: false },
  );
  failed("Could not unsnooze", result);
}

/** Puts one task off on every device; the thread itself stays as it is. */
export async function snoozeTask(input: {
  readonly environmentId: EnvironmentId;
  readonly key: TaskKey;
  readonly snoozedUntil: string;
}): Promise<UndoOutcome | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.setTaskSnooze,
    {
      environmentId: input.environmentId,
      input: { key: input.key, snoozedUntil: input.snoozedUntil },
    },
    { reportFailure: false },
  );
  if (failed("Could not snooze", result)) return null;
  const until = formatUpcomingTimestamp(input.snoozedUntil, getClientSettings().timestampFormat);
  return withUndo(`Snoozed until ${until}`, () => clearTaskSnooze(input.environmentId, input.key));
}

export async function completeTodo(
  environmentId: EnvironmentId,
  todo: Pick<UserTodo, "id" | "title">,
): Promise<UndoOutcome | null> {
  const setCompleted = (completed: boolean) =>
    runAtomCommand(
      appAtomRegistry,
      serverEnvironment.setUserTodoCompleted,
      { environmentId, input: { id: todo.id, completed } },
      { reportFailure: false },
    );
  if (failed("Could not complete the todo", await setCompleted(true))) return null;
  return withUndo(`Done: ${todo.title}`, async () => {
    failed("Could not reopen the todo", await setCompleted(false));
  });
}
