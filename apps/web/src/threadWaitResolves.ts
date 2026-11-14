import { cockpitItemKey } from "@t3tools/client-runtime/state/cockpit-queue";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { taskWaitKey, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";

const UNDO_WINDOW_MS = 5_000;

interface PendingWaitResolve {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly waitId: string;
  readonly note: string | undefined;
  /** The wait list it answers. A list the agent sets again shows its waits even if ids repeat. */
  readonly setAt: string;
  readonly timer: ReturnType<typeof setTimeout> | null;
  readonly toastId: string | null;
}

/** Answers held for Undo, and those sent until the wait leaves the thread, by cockpit item key. */
export const usePendingWaitResolves = create<{
  readonly pending: ReadonlyMap<string, PendingWaitResolve>;
}>(() => ({ pending: new Map() }));

function update(key: string, entry: PendingWaitResolve | null) {
  const pending = new Map(usePendingWaitResolves.getState().pending);
  if (entry === null) pending.delete(key);
  else pending.set(key, entry);
  usePendingWaitResolves.setState({ pending });
}

/** Whether the queue and the thread hide this wait because its answer is on the way. */
export function isWaitResolvePending(
  pending: ReadonlyMap<string, PendingWaitResolve>,
  key: string,
  setAt: string | undefined,
): boolean {
  return pending.get(key)?.setAt === setAt;
}

async function send(key: string, entry: PendingWaitResolve) {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveThreadWait,
    {
      environmentId: entry.environmentId,
      input: {
        threadId: entry.threadId,
        waitId: entry.waitId,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  // Resolved elsewhere, or the agent already dropped it: either way it is gone.
  if (Predicate.isTagged(error, "ThreadWaitNotFoundError")) return;
  update(key, null);
  toastManager.add({
    type: "error",
    title: "Could not wake the thread",
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

function flush(key: string) {
  const entry = usePendingWaitResolves.getState().pending.get(key);
  if (entry === undefined || entry.timer === null) return;
  clearTimeout(entry.timer);
  const sent = { ...entry, timer: null };
  update(key, sent);
  void send(key, sent);
}

export const waitResolveKey = (environmentId: EnvironmentId, threadId: ThreadId, waitId: string) =>
  cockpitItemKey(environmentId, taskWaitKey(threadId, waitId));

/** False once the answer was sent. */
export function undoWaitResolve(key: string): boolean {
  const entry = usePendingWaitResolves.getState().pending.get(key);
  if (entry === undefined || entry.timer === null) return false;
  clearTimeout(entry.timer);
  if (entry.toastId !== null) toastManager.close(entry.toastId);
  update(key, null);
  return true;
}

/**
 * Hides the wait at once and wakes the thread after an Undo window. It survives navigation and
 * the cockpit moving on; closing the page sends what is still held. Returns the wait's key.
 */
export function scheduleWaitResolve(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly waitId: string;
  readonly setAt: string;
  readonly note?: string | undefined;
}) {
  const key = waitResolveKey(input.environmentId, input.threadId, input.waitId);
  flush(key);
  const timer = setTimeout(() => flush(key), UNDO_WINDOW_MS);
  const toastId = toastManager.add({
    type: "info",
    title: `Waking ${input.threadTitle} in 5s`,
    timeout: UNDO_WINDOW_MS,
    actionProps: { children: "Undo", onClick: () => undoWaitResolve(key) },
  });
  update(key, {
    environmentId: input.environmentId,
    threadId: input.threadId,
    waitId: input.waitId,
    note: input.note?.trim() || undefined,
    setAt: input.setAt,
    timer,
    toastId,
  });
  return key;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const key of usePendingWaitResolves.getState().pending.keys()) flush(key);
  });
}
