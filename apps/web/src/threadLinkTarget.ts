import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  guessThreadLinkRef,
  threadLinkCandidates,
  type ThreadLink,
} from "@t3tools/shared/threadLinks";

export type ThreadLinkThreadState = "open" | "archived" | "missing";

export interface ThreadLinkLookup {
  /** Null when this app doesn't know the environment. */
  readonly environment: (
    environmentId: EnvironmentId,
  ) => { readonly label: string; readonly connected: boolean } | null;
  /** The threads in connected environments' lists, for a v1 link, which names no environment. */
  readonly listedRefs: () => ReadonlyArray<ScopedThreadRef>;
  readonly thread: (ref: ScopedThreadRef) => Promise<ThreadLinkThreadState>;
}

export type ThreadLinkTarget =
  | { readonly kind: "open" | "archived"; readonly ref: ScopedThreadRef }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Where a link from outside the app leads, or why it leads nowhere. */
export async function resolveThreadLinkTarget(
  link: ThreadLink,
  primaryEnvironmentId: EnvironmentId | null,
  lookup: ThreadLinkLookup,
): Promise<ThreadLinkTarget> {
  const guess = link.environmentId === null ? guessThreadLinkRef(link, lookup.listedRefs()) : null;
  if (guess !== null) return { kind: "open", ref: guess };
  const environmentId = link.environmentId ?? primaryEnvironmentId;
  if (environmentId === null) {
    return { kind: "unavailable", reason: "No connected environment has this thread." };
  }
  const environment = lookup.environment(environmentId);
  if (environment === null) {
    return {
      kind: "unavailable",
      reason: `The thread is on environment ${environmentId}, which this app isn't connected to.`,
    };
  }
  if (!environment.connected) {
    return { kind: "unavailable", reason: `${environment.label} is offline.` };
  }
  for (const ref of threadLinkCandidates(link, environmentId)) {
    const state = await lookup.thread(ref);
    if (state !== "missing") return { kind: state, ref };
  }
  return {
    kind: "unavailable",
    reason: `${environment.label} has no such thread. It may have been deleted.`,
  };
}
