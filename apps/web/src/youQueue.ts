import { useAtomValue } from "@effect/atom-react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  deriveYouQueue,
  nextYouQueueItem,
  type YouQueue,
  type YouQueueInput,
  type YouQueueItem,
} from "@t3tools/client-runtime/state/you-queue";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import { useNowMinute } from "./hooks/useNowMinute";
import { useThreadRouteRef } from "./hooks/useThreadRouteTarget";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "./state/entities";
import { environmentSummaries } from "./state/presentation";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { environmentProjects } from "./state/projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";
import { environmentThreadShells } from "./state/threads";
import { buildThreadRouteParams, resolveThreadRouteRef } from "./threadRoutes";
import { isWaitResolvePending, usePendingWaitResolves } from "./threadWaitResolves";
import { useUiStateStore } from "./uiStateStore";

/** Todos and the overview agent live here: the primary environment, else the first connected one. */
export const youEnvironmentIdAtom = Atom.make(
  (get): EnvironmentId | null =>
    get(primaryEnvironmentIdAtom) ??
    get(environmentSummaries.connectedEnvironmentIdsAtom)[0] ??
    null,
).pipe(Atom.withLabel("web:you-environment-id"));

/** The overview thread's key, `environmentId:threadId`, once the user has started one. */
export const overviewThreadKeyAtom = Atom.make((get) => {
  const environmentId = get(youEnvironmentIdAtom);
  if (environmentId === null) return null;
  const threadId = get(environmentServerConfigsAtom).get(environmentId)?.settings.overviewThreadId;
  return threadId == null ? null : scopedThreadKey(scopeThreadRef(environmentId, threadId));
}).pipe(Atom.withLabel("web:overview-thread-key"));

// Older servers have no todos; their subscriptions fail and list nothing.
const youTodoListsAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const result = get(serverEnvironment.userTodosLive({ environmentId, input: {} }));
    const todos = AsyncResult.getOrElse(result, () => null)?.todos;
    return todos === undefined ? [] : [{ environmentId, todos }];
  }),
).pipe(Atom.withLabel("web:you-todo-lists"));

/** The thread last opened from the queue, so opening it does not drop its unseen completion. */
const useYouQueueNavigation = create<{ readonly retainedThreadKey: string | null }>(() => ({
  retainedThreadKey: null,
}));

function queueInput(parts: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly todos: YouQueueInput["todos"];
  readonly nowMinute: string;
  readonly notHereKeys: ReadonlyArray<string>;
  readonly pending: ReturnType<typeof usePendingWaitResolves.getState>["pending"];
  readonly retainedThreadKey: string | null;
  readonly routeThreadKey: string | null;
  readonly overviewThreadKey: string | null;
}): YouQueueInput {
  const hiddenKeys = new Set<string>();
  if (parts.pending.size > 0) {
    const setAtByThread = new Map(
      parts.threads.map((thread) => [
        `${thread.environmentId}:${thread.id}`,
        thread.waiting?.setAt,
      ]),
    );
    for (const [key, entry] of parts.pending) {
      const setAt = setAtByThread.get(`${entry.environmentId}:${entry.threadId}`);
      if (isWaitResolvePending(parts.pending, key, setAt)) hiddenKeys.add(key);
    }
  }
  return {
    threads: parts.threads,
    todos: parts.todos,
    // The minute tick is UTC without seconds.
    now: `${parts.nowMinute}:00.000Z`,
    notHereKeys: new Set(parts.notHereKeys),
    delegatedUnderParent: parts.delegatedUnderParent,
    projectTitles: new Map(
      parts.projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    ),
    hiddenKeys,
    retainedThreadKey:
      parts.retainedThreadKey === parts.routeThreadKey ? parts.retainedThreadKey : null,
    overviewThreadKey: parts.overviewThreadKey,
  };
}

/** Mount once: the sidebar's mode toggle or its You view. */
export function useYouQueue(): YouQueue {
  const routeRef = useThreadRouteRef();
  const routeThreadKey = routeRef === null ? null : scopedThreadKey(routeRef);
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projects = useProjects();
  const todos = useAtomValue(youTodoListsAtom);
  const nowMinute = useNowMinute();
  const notHereKeys = useUiStateStore((state) => state.youNotHereKeys);
  const pending = usePendingWaitResolves((state) => state.pending);
  const retainedThreadKey = useYouQueueNavigation((state) => state.retainedThreadKey);
  const overviewThreadKey = useAtomValue(overviewThreadKeyAtom);
  const queue = deriveYouQueue(
    queueInput({
      threads,
      delegatedUnderParent,
      projects,
      todos,
      nowMinute,
      notHereKeys,
      pending,
      retainedThreadKey,
      routeThreadKey,
      overviewThreadKey,
    }),
  );
  const retainIfReturned = useEffectEvent((threadKey: string | null) => {
    const returned = queue.now.some(
      (item) => item.threadKey === threadKey && item.kind === "review",
    );
    useYouQueueNavigation.setState({ retainedThreadKey: returned ? threadKey : null });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening a thread marks it seen on the server; hold its unseen result while it stays open, however it was opened
  useEffect(() => {
    retainIfReturned(routeThreadKey);
  }, [routeThreadKey]);
  return queue;
}

function readRouteThreadKey(router: AnyRouter): string | null {
  const ref = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  return ref === null ? null : scopedThreadKey(ref);
}

function readYouQueue(router: AnyRouter): YouQueue {
  return deriveYouQueue(
    queueInput({
      threads: appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom),
      delegatedUnderParent: appAtomRegistry.get(environmentThreadShells.delegatedUnderParentAtom),
      projects: appAtomRegistry.get(environmentProjects.projectsAtom),
      todos: appAtomRegistry.get(youTodoListsAtom),
      nowMinute: minuteTick.getSnapshot(),
      notHereKeys: useUiStateStore.getState().youNotHereKeys,
      pending: usePendingWaitResolves.getState().pending,
      retainedThreadKey: useYouQueueNavigation.getState().retainedThreadKey,
      routeThreadKey: readRouteThreadKey(router),
      overviewThreadKey: appAtomRegistry.get(overviewThreadKeyAtom),
    }),
  );
}

export function openYouQueueItem(router: AnyRouter, item: YouQueueItem) {
  if (item.threadId === null) return;
  const ref = scopeThreadRef(item.environmentId, item.threadId);
  useYouQueueNavigation.setState({ retainedThreadKey: scopedThreadKey(ref) });
  void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}

/** Opens the next thread waiting on the user after the open one, for Next and its shortcut. */
export function openNextYouQueueItem(router: AnyRouter) {
  const next = nextYouQueueItem(readYouQueue(router).now, readRouteThreadKey(router));
  if (next === null) {
    toastManager.add({ type: "info", title: "Nothing else is waiting on you", timeout: 2_000 });
    return;
  }
  openYouQueueItem(router, next);
}
