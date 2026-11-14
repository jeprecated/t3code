import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveCockpitQueue, type CockpitQueue } from "@t3tools/client-runtime/state/cockpit-queue";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useNowMinute } from "./hooks/useNowMinute";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "./state/entities";
import { environmentSummaries } from "./state/presentation";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";
import { isWaitResolvePending, usePendingWaitResolves } from "./threadWaitResolves";

/** Todos and the overview agent live here: the primary environment, else the first connected one. */
export const overviewEnvironmentIdAtom = Atom.make(
  (get): EnvironmentId | null =>
    get(primaryEnvironmentIdAtom) ??
    get(environmentSummaries.connectedEnvironmentIdsAtom)[0] ??
    null,
).pipe(Atom.withLabel("web:overview-environment-id"));

/** The overview thread's key, `environmentId:threadId`, once the user has started one. */
export const overviewThreadKeyAtom = Atom.make((get) => {
  const environmentId = get(overviewEnvironmentIdAtom);
  if (environmentId === null) return null;
  const threadId = get(environmentServerConfigsAtom).get(environmentId)?.settings.overviewThreadId;
  return threadId == null ? null : scopedThreadKey(scopeThreadRef(environmentId, threadId));
}).pipe(Atom.withLabel("web:overview-thread-key"));

// Older servers have neither; their subscriptions fail and list nothing.
const todoListsAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const result = get(serverEnvironment.userTodosLive({ environmentId, input: {} }));
    const todos = AsyncResult.getOrElse(result, () => null)?.todos;
    return todos === undefined ? [] : [{ environmentId, todos }];
  }),
).pipe(Atom.withLabel("web:cockpit-todo-lists"));

const taskSnoozeListsAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const result = get(serverEnvironment.taskSnoozesLive({ environmentId, input: {} }));
    const snoozes = AsyncResult.getOrElse(result, () => null)?.snoozes;
    return snoozes === undefined ? [] : [{ environmentId, snoozes }];
  }),
).pipe(Atom.withLabel("web:cockpit-task-snoozes"));

/** The badge and the cockpit both mount this; it is one pass over the thread shells. */
export function useCockpitQueue(): CockpitQueue {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projects = useProjects();
  const todos = useAtomValue(todoListsAtom);
  const snoozes = useAtomValue(taskSnoozeListsAtom);
  // The subscription does not re-send when a snooze ends; the minute clock brings it back.
  const nowMinute = useNowMinute();
  const pending = usePendingWaitResolves((state) => state.pending);
  const overviewThreadKey = useAtomValue(overviewThreadKeyAtom);

  const hiddenKeys = new Set<string>();
  if (pending.size > 0) {
    const setAtByThread = new Map(
      threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.waiting?.setAt]),
    );
    for (const [key, entry] of pending) {
      const setAt = setAtByThread.get(`${entry.environmentId}:${entry.threadId}`);
      if (isWaitResolvePending(pending, key, setAt)) hiddenKeys.add(key);
    }
  }
  return deriveCockpitQueue({
    threads,
    todos,
    snoozes,
    // The minute tick is UTC without seconds.
    now: `${nowMinute}:00.000Z`,
    delegatedUnderParent,
    projectTitles: new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    ),
    hiddenKeys,
    overviewThreadKey,
  });
}
