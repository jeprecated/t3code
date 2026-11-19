// oxlint-disable t3code/no-untranslated-copy -- fork-only cockpit copy, English until it is translated
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
  /** True while Undo can still take it back; false once sent. */
  readonly held: boolean;
}

/** One thread's held answers share a window, so they wake its agent once. */
interface HeldBatch {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly toastId: string;
}

/** Answers held for Undo, and those sent until the wait leaves the thread, by cockpit item key. */
export const usePendingWaitResolves = create<{
  readonly pending: ReadonlyMap<string, PendingWaitResolve>;
  /** By `batchKey`. */
  readonly batches: ReadonlyMap<string, HeldBatch>;
}>(() => ({ pending: new Map(), batches: new Map() }));

const batchKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

function setPending(changes: ReadonlyArray<readonly [string, PendingWaitResolve | null]>) {
  const pending = new Map(usePendingWaitResolves.getState().pending);
  for (const [key, entry] of changes) {
    if (entry === null) pending.delete(key);
    else pending.set(key, entry);
  }
  usePendingWaitResolves.setState({ pending });
}

function setBatch(key: string, batch: HeldBatch | null) {
  const batches = new Map(usePendingWaitResolves.getState().batches);
  if (batch === null) batches.delete(key);
  else batches.set(key, batch);
  usePendingWaitResolves.setState({ batches });
}

/** Held answers to one thread, oldest first. */
function heldFor(environmentId: EnvironmentId, threadId: ThreadId) {
  return [...usePendingWaitResolves.getState().pending].filter(
    ([, entry]) =>
      entry.held && entry.environmentId === environmentId && entry.threadId === threadId,
  );
}

/** Whether the queue and the thread hide this wait because its answer is on the way. */
export function isWaitResolvePending(
  pending: ReadonlyMap<string, PendingWaitResolve>,
  key: string,
  setAt: string | undefined,
): boolean {
  return pending.get(key)?.setAt === setAt;
}

async function send(entries: ReadonlyArray<readonly [string, PendingWaitResolve]>) {
  const [first] = entries;
  if (first === undefined) return;
  const [, { environmentId, threadId }] = first;
  const toAnswer = ([, entry]: readonly [string, PendingWaitResolve]) => ({
    waitId: entry.waitId,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  });
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveThreadWait,
    {
      environmentId,
      input: { threadId, answers: [toAnswer(first), ...entries.slice(1).map(toAnswer)] },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  // Resolved elsewhere, or the agent already dropped them: either way they are gone.
  if (Predicate.isTagged(error, "ThreadWaitNotFoundError")) return;
  setPending(entries.map(([key]) => [key, null] as const));
  toastManager.add({
    type: "error",
    title: "Could not wake the thread",
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

function flushThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const key = batchKey(environmentId, threadId);
  const batch = usePendingWaitResolves.getState().batches.get(key);
  if (batch !== undefined) clearTimeout(batch.timer);
  setBatch(key, null);
  const held = heldFor(environmentId, threadId);
  const sent = held.map(([waitKey, entry]) => [waitKey, { ...entry, held: false }] as const);
  setPending(sent);
  void send(sent);
}

function cancelBatch(environmentId: EnvironmentId, threadId: ThreadId) {
  const key = batchKey(environmentId, threadId);
  const batch = usePendingWaitResolves.getState().batches.get(key);
  if (batch === undefined) return;
  clearTimeout(batch.timer);
  toastManager.close(batch.toastId);
  setBatch(key, null);
}

export const waitResolveKey = (environmentId: EnvironmentId, threadId: ThreadId, waitId: string) =>
  cockpitItemKey(environmentId, taskWaitKey(threadId, waitId));

/** Takes back one held answer; the thread's other held answers still go. False once sent. */
export function undoWaitResolve(key: string): boolean {
  const entry = usePendingWaitResolves.getState().pending.get(key);
  if (entry === undefined || !entry.held) return false;
  setPending([[key, null]]);
  if (heldFor(entry.environmentId, entry.threadId).length === 0) {
    cancelBatch(entry.environmentId, entry.threadId);
  }
  return true;
}

function undoThread(environmentId: EnvironmentId, threadId: ThreadId) {
  setPending(heldFor(environmentId, threadId).map(([key]) => [key, null] as const));
  cancelBatch(environmentId, threadId);
}

/**
 * Hides the wait at once and wakes the thread after an Undo window, which restarts with each
 * answer to the same thread so they reach its agent together. It survives navigation and the
 * cockpit moving on; closing the page sends what is still held. Returns the wait's key.
 */
export function scheduleWaitResolve(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly waitId: string;
  readonly setAt: string;
  readonly note?: string | undefined;
}) {
  const { environmentId, threadId } = input;
  const key = waitResolveKey(environmentId, threadId, input.waitId);
  cancelBatch(environmentId, threadId);
  setPending([
    [
      key,
      {
        environmentId,
        threadId,
        waitId: input.waitId,
        note: input.note?.trim() || undefined,
        setAt: input.setAt,
        held: true,
      },
    ],
  ]);
  const count = heldFor(environmentId, threadId).length;
  const timer = setTimeout(() => flushThread(environmentId, threadId), UNDO_WINDOW_MS);
  const toastId = toastManager.add({
    type: "info",
    title: `Waking ${input.threadTitle} in 5s`,
    ...(count > 1 ? { description: `${count} answers` } : {}),
    timeout: UNDO_WINDOW_MS,
    actionProps: { children: "Undo", onClick: () => undoThread(environmentId, threadId) },
  });
  setBatch(batchKey(environmentId, threadId), { timer, toastId });
  return key;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const entry of usePendingWaitResolves.getState().pending.values()) {
      if (entry.held) flushThread(entry.environmentId, entry.threadId);
    }
  });
}
