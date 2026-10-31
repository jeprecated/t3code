import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

import type { EnvironmentId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { isSidebarSubagentThread } from "./Sidebar.logic";

export const THREAD_SWITCHER_RESULT_LIMIT = 50;

// Match quality ranks first, so an exact repo match beats a fuzzy hit scattered
// across a name. Within one quality, name beats repo beats workspace.
const QUALITY_BAND = 10_000;
const FIELD_STEP = 1_000;

export type ThreadSwitcherThread = ThreadSnoozeShell &
  Pick<
    SidebarThreadSummary,
    | "archivedAt"
    | "branch"
    | "environmentId"
    | "id"
    | "lineage"
    | "settledOverride"
    | "title"
    | "worktreePath"
  >;

/**
 * The Settled shelf the switcher reads while settled threads show: every page of older settled
 * threads (which shells leave out) in every environment, so a search matches the threads it would
 * if every thread were loaded. Nothing loads while settled threads are hidden.
 */
export function threadSwitcherOlderSettledShelf(
  environmentIds: ReadonlyArray<EnvironmentId>,
  includeSettled: boolean,
): {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly expanded: boolean;
  readonly visibleCount: number;
} {
  return {
    scopes: environmentIds.map((environmentId) => ({ environmentId, projectIds: null })),
    expanded: includeSettled,
    visibleCount: Number.POSITIVE_INFINITY,
  };
}

function worktreeName(path: string | null): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

function scoreToken(fields: ReadonlyArray<ReadonlyArray<string>>, token: string): number | null {
  let best: number | null = null;
  for (const [field, values] of fields.entries()) {
    for (const value of values) {
      const raw = scoreQueryMatch({
        value,
        query: token,
        exactBase: 0,
        prefixBase: QUALITY_BAND,
        boundaryBase: 2 * QUALITY_BAND,
        includesBase: 3 * QUALITY_BAND,
        fuzzyBase: 4 * QUALITY_BAND,
      });
      if (raw === null) continue;
      const quality = Math.min(4, Math.floor(raw / QUALITY_BAND));
      const penalty = Math.min(raw - quality * QUALITY_BAND, FIELD_STEP - 1);
      const score = quality * QUALITY_BAND + field * FIELD_STEP + penalty;
      if (best === null || score < best) best = score;
    }
  }
  return best;
}

/**
 * Settled and snoozed threads stay out unless `includeSettled`. `threads`
 * arrive in display order, which breaks ties; the current thread sinks to the
 * end so Enter always jumps somewhere else.
 */
export function rankThreadSwitcherThreads<T extends ThreadSwitcherThread>(
  threads: ReadonlyArray<T>,
  input: {
    readonly query: string;
    readonly includeSettled: boolean;
    readonly now: string;
    readonly currentThreadKey: string | null;
    readonly repoOf: (thread: T) => string | null;
    readonly limit?: number;
  },
): T[] {
  const tokens = normalizeSearchQuery(input.query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  const ranked: Array<{ thread: T; score: number; index: number; current: boolean }> = [];

  for (const [index, thread] of threads.entries()) {
    if (thread.archivedAt !== null || isSidebarSubagentThread(thread)) continue;
    if (
      !input.includeSettled &&
      (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now: input.now }))
    ) {
      continue;
    }

    let score = 0;
    if (tokens.length > 0) {
      const fields = [
        [thread.title],
        [input.repoOf(thread)],
        [thread.branch, worktreeName(thread.worktreePath)],
      ].map((values) => values.flatMap((value) => (value ? [normalizeSearchQuery(value)] : [])));
      let matched = true;
      for (const token of tokens) {
        const tokenScore = scoreToken(fields, token);
        if (tokenScore === null) {
          matched = false;
          break;
        }
        score += tokenScore;
      }
      if (!matched) continue;
    }

    ranked.push({
      thread,
      score,
      index,
      current: `${thread.environmentId}:${thread.id}` === input.currentThreadKey,
    });
  }

  return ranked
    .toSorted(
      (left, right) =>
        Number(left.current) - Number(right.current) ||
        left.score - right.score ||
        left.index - right.index,
    )
    .slice(0, input.limit ?? THREAD_SWITCHER_RESULT_LIMIT)
    .map((entry) => entry.thread);
}
