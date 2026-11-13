import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadWait,
  type ThreadId,
  type UserTodo,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { scopedThreadKey } from "../environment/scoped.ts";
import { threadKey } from "./entities.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

export type YouQueueKind =
  | "approval"
  | "question"
  | "request"
  | "decision"
  | "manual_step"
  | "blocked"
  | "plan"
  | "review"
  | "fix"
  | "todo";

export type YouQueueGroup = "now" | "later" | "elsewhere" | "todos";

export interface YouQueueItem {
  /** Stable across updates; the device-local "not here" set stores these. */
  readonly key: string;
  readonly kind: YouQueueKind;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  /** `environmentId:threadId`, as routes key threads; null for todos. */
  readonly threadKey: string | null;
  readonly threadId: ThreadId | null;
  readonly threadTitle: string | null;
  readonly projectTitle: string | null;
  /** When the user started being waited on. */
  readonly since: string;
  /** The agent is still working, so it is not blocked on this yet. */
  readonly working: boolean;
  readonly where: string | null;
  /** When it becomes doable: a wait's or todo's own time, else the thread's snooze end. */
  readonly notBefore: string | null;
  readonly wait: OrchestrationV2ThreadWait | null;
  readonly todo: UserTodo | null;
}

export interface YouQueue {
  readonly now: ReadonlyArray<YouQueueItem>;
  readonly later: ReadonlyArray<YouQueueItem>;
  readonly elsewhere: ReadonlyArray<YouQueueItem>;
  readonly todos: ReadonlyArray<YouQueueItem>;
}

export interface YouQueueInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly todos: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly todos: ReadonlyArray<UserTodo>;
  }>;
  readonly now: string;
  readonly notHereKeys: ReadonlySet<string>;
  /** Thread keys (see `threadKey`) of tasks linked environments list under their parent. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  /** Display names by `environmentId:projectId`. */
  readonly projectTitles: ReadonlyMap<string, string>;
  /** Wait item keys the user already answered, while the answer is on its way. */
  readonly hiddenKeys?: ReadonlySet<string>;
  /** Its unseen completion stays listed though it is now seen, because the user opened it from here. */
  readonly retainedThreadKey?: string | null;
  /** Pinned above the queue with its own status, so its finished turns are not listed. */
  readonly overviewThreadKey?: string | null;
}

const KIND_RANK: Record<YouQueueKind, number> = {
  approval: 0,
  question: 1,
  decision: 2,
  request: 3,
  manual_step: 3,
  blocked: 4,
  plan: 5,
  review: 6,
  fix: 7,
  todo: 8,
};

const APPROVAL_TITLES: Record<string, string> = {
  command: "Approve a command",
  "file-read": "Approve reading a file",
  "file-change": "Approve file changes",
  permission: "Grant a permission",
  "mcp-elicitation": "Answer a tool's request",
  dynamic_tool_call: "Approve a tool call",
};

export const youQueueTodoKey = (environmentId: EnvironmentId, id: string) =>
  `${environmentId}:todo:${id}`;

export const youQueueWaitKey = (environmentId: EnvironmentId, threadId: ThreadId, waitId: string) =>
  `${environmentId}:${threadId}:wait:${waitId}`;

const ms = (iso: string | null | undefined) => {
  const value = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
};

function liveAsk(
  thread: EnvironmentThreadShell,
): { kind: YouQueueKind; title: string; since: string } | null {
  const request = thread.source.pendingRuntimeRequest;
  const since = request ? DateTime.formatIso(request.createdAt) : thread.updatedAt;
  if (thread.hasPendingApprovals) {
    return {
      kind: "approval",
      title: APPROVAL_TITLES[request?.kind ?? ""] ?? "Approve a request",
      since,
    };
  }
  // Secret and link cards arrive as questions too; the shell cannot tell them apart.
  if (thread.hasPendingUserInput) return { kind: "question", title: "Answer the agent", since };
  if (thread.pendingSubagentRequest === "approval") {
    return { kind: "approval", title: "A subagent needs approval", since };
  }
  if (thread.pendingSubagentRequest === "user_input") {
    return { kind: "question", title: "A subagent asks you something", since };
  }
  if (request?.kind === "auth_refresh") {
    return { kind: "request", title: "Sign in to the provider again", since };
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return { kind: "request", title: "Review guest messages", since };
  }
  return null;
}

function returned(
  thread: EnvironmentThreadShell,
  retained: boolean,
): { kind: YouQueueKind; title: string; since: string } | null {
  const run = thread.latestRun;
  if (run === null || thread.settledOverride === "settled") return null;
  if (threadRuntimeIsActive(thread.runtime) || isThreadWorking(thread)) return null;
  const since = run.completedAt ?? thread.updatedAt;
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) {
    return { kind: "plan", title: "Review the plan", since };
  }
  if (thread.runtime?.status === "failed" || run.status === "failed") {
    return {
      kind: "fix",
      title:
        thread.runtime?.lastErrorClass === "usage_limit"
          ? "Usage limit reached"
          : thread.runtime?.lastError?.split("\n")[0]?.trim() || "The run failed",
      since,
    };
  }
  const unseen =
    run.completedAt !== null &&
    (thread.lastVisitedAt === null ||
      (thread.lastVisitedAt !== undefined && ms(run.completedAt) > ms(thread.lastVisitedAt)));
  if (!unseen && !retained) return null;
  const message = thread.source.latestVisibleMessage;
  const firstLine =
    message?.role === "assistant" ? message.text.trim().split("\n")[0]?.trim() : undefined;
  return { kind: "review", title: firstLine || "Review the result", since };
}

const compareNow = (left: YouQueueItem, right: YouQueueItem) =>
  Number(left.working) - Number(right.working) ||
  KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
  ms(left.since) - ms(right.since) ||
  left.key.localeCompare(right.key);

/**
 * Everything agents wait on from the user, and the user's own todos, in one pass over the
 * thread shells. `now` is the badge count and triage order.
 */
export function deriveYouQueue(input: YouQueueInput): YouQueue {
  const nowMs = ms(input.now);
  const now: YouQueueItem[] = [];
  const later: YouQueueItem[] = [];
  const elsewhere: YouQueueItem[] = [];
  const todos: YouQueueItem[] = [];
  const place = (item: YouQueueItem, snoozedUntil: string | null) => {
    if (input.hiddenKeys?.has(item.key)) return;
    if (input.notHereKeys.has(item.key)) {
      elsewhere.push(item);
    } else if (item.notBefore !== null && ms(item.notBefore) > nowMs) {
      later.push(item);
    } else if (snoozedUntil !== null) {
      later.push({ ...item, notBefore: snoozedUntil });
    } else if (item.kind === "todo") {
      todos.push(item);
    } else {
      now.push(item);
    }
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    // Subagent and delegated asks surface on their parent's own shell.
    if (!isListedThreadLineage(thread.lineage)) continue;
    if (
      input.delegatedUnderParent.has(
        threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      continue;
    }
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const base = {
      environmentId: thread.environmentId,
      threadKey: key,
      threadId: thread.id,
      threadTitle: thread.title,
      projectTitle: input.projectTitles.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      working: isThreadWorking(thread),
      todo: null,
    };
    const snoozedUntil = effectiveSnoozed(thread, { now: input.now }) ? thread.snoozedUntil : null;
    const ask = liveAsk(thread);
    if (ask !== null) {
      place(
        // A live ask holds its run, so the agent waits on it whatever its run status says.
        {
          ...base,
          ...ask,
          key: `${key}:ask`,
          working: false,
          where: null,
          notBefore: null,
          wait: null,
        },
        snoozedUntil,
      );
    }
    const waiting = thread.waiting ?? null;
    for (const wait of waiting?.items ?? []) {
      place(
        {
          ...base,
          key: youQueueWaitKey(thread.environmentId, thread.id, wait.id),
          kind: wait.kind,
          title: wait.summary,
          since: waiting?.setAt ?? thread.updatedAt,
          where: wait.where ?? null,
          notBefore: wait.notBefore ?? null,
          wait,
        },
        snoozedUntil,
      );
    }
    if (ask !== null || waiting !== null || key === input.overviewThreadKey) continue;
    const back = returned(thread, key === input.retainedThreadKey);
    if (back !== null) {
      place(
        { ...base, ...back, key: `${key}:returned`, where: null, notBefore: null, wait: null },
        snoozedUntil,
      );
    }
  }

  for (const { environmentId, todos: environmentTodos } of input.todos) {
    for (const todo of environmentTodos) {
      if (todo.completedAt !== null) continue;
      place(
        {
          key: youQueueTodoKey(environmentId, todo.id),
          kind: "todo",
          title: todo.title,
          environmentId,
          threadKey: null,
          threadId: null,
          threadTitle: null,
          projectTitle: null,
          since: todo.createdAt,
          working: false,
          where: todo.where ?? null,
          notBefore: todo.notBefore ?? null,
          wait: null,
          todo,
        },
        null,
      );
    }
  }

  return {
    now: now.sort(compareNow),
    later: later.sort(
      (left, right) =>
        ms(left.notBefore) - ms(right.notBefore) || left.key.localeCompare(right.key),
    ),
    elsewhere: elsewhere.sort(compareNow),
    todos: todos.sort(
      (left, right) => ms(left.since) - ms(right.since) || left.key.localeCompare(right.key),
    ),
  };
}

/** The `now` item after the open thread's, wrapping around, on another thread. */
export function nextYouQueueItem(
  now: ReadonlyArray<YouQueueItem>,
  openThreadKey: string | null,
): YouQueueItem | null {
  const at =
    openThreadKey === null ? -1 : now.findIndex((item) => item.threadKey === openThreadKey);
  const ordered = at < 0 ? now : [...now.slice(at + 1), ...now.slice(0, at)];
  return ordered.find((item) => item.threadKey !== openThreadKey) ?? null;
}

/**
 * Where triage goes once the open thread's last `now` item leaves the queue: the item that
 * followed it, if it is still there. Null while the open thread still waits on the user.
 */
export function youQueueTriageTarget(
  previous: ReadonlyArray<YouQueueItem>,
  current: ReadonlyArray<YouQueueItem>,
  openThreadKey: string | null,
): YouQueueItem | null {
  if (openThreadKey === null) return null;
  if (!previous.some((item) => item.threadKey === openThreadKey)) return null;
  if (current.some((item) => item.threadKey === openThreadKey)) return null;
  const remaining = new Set(current.map((item) => item.key));
  const next = nextYouQueueItem(
    previous.filter((item) => item.threadKey === openThreadKey || remaining.has(item.key)),
    openThreadKey,
  );
  return next === null ? null : (current.find((item) => item.key === next.key) ?? null);
}
