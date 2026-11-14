import {
  isListedThreadLineage,
  taskRequestKey,
  taskThreadKey,
  taskTodoKey,
  taskWaitKey,
  type EnvironmentId,
  type OrchestrationV2ThreadWait,
  type RuntimeRequestId,
  type TaskKey,
  type TaskSnooze,
  type ThreadId,
  type UserTodo,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { scopedThreadKey } from "../environment/scoped.ts";
import { threadKey } from "./entities.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

export type CockpitKind =
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

export interface CockpitItem {
  /** Unique across environments: `environmentId:taskKey`. */
  readonly key: string;
  /** What task snoozes are stored under, in the item's environment. */
  readonly taskKey: TaskKey;
  readonly kind: CockpitKind;
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
  readonly notBefore: string | null;
  /** The live request a question or approval answers. */
  readonly requestId: RuntimeRequestId | null;
  readonly wait: OrchestrationV2ThreadWait | null;
  readonly todo: UserTodo | null;
  /** In `snoozed`: when it comes back, and what holds it until then. */
  readonly until: string | null;
  readonly snoozedBy: "task" | "thread" | "time" | null;
}

export interface CockpitQueue {
  readonly now: ReadonlyArray<CockpitItem>;
  readonly snoozed: ReadonlyArray<CockpitItem>;
}

export interface CockpitQueueInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly todos: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly todos: ReadonlyArray<UserTodo>;
  }>;
  readonly snoozes: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snoozes: ReadonlyArray<TaskSnooze>;
  }>;
  readonly now: string;
  /** Thread keys (see `threadKey`) of tasks linked environments list under their parent. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  /** Display names by `environmentId:projectId`. */
  readonly projectTitles: ReadonlyMap<string, string>;
  /** Item keys the user already finished, while that reaches the server. */
  readonly hiddenKeys?: ReadonlySet<string>;
  /** The overview agent's own thread, whose finished turns are not tasks. */
  readonly overviewThreadKey?: string | null;
}

const KIND_RANK: Record<CockpitKind, number> = {
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

export const cockpitItemKey = (environmentId: EnvironmentId, taskKey: TaskKey) =>
  `${environmentId}:${taskKey}`;

const ms = (iso: string | null | undefined) => {
  const value = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
};

type Ask = {
  kind: CockpitKind;
  title: string;
  since: string;
  requestId: RuntimeRequestId | null;
};

function liveAsk(thread: EnvironmentThreadShell): Ask | null {
  const request = thread.source.pendingRuntimeRequest;
  const since = request ? DateTime.formatIso(request.createdAt) : thread.updatedAt;
  const requestId = request?.id ?? null;
  if (thread.hasPendingApprovals) {
    return {
      kind: "approval",
      title: APPROVAL_TITLES[request?.kind ?? ""] ?? "Approve a request",
      since,
      requestId,
    };
  }
  // Secret and link cards arrive as questions too; the shell cannot tell them apart.
  if (thread.hasPendingUserInput) {
    return { kind: "question", title: "Answer the agent", since, requestId };
  }
  if (thread.pendingSubagentRequest === "approval") {
    return { kind: "approval", title: "A subagent needs approval", since, requestId: null };
  }
  if (thread.pendingSubagentRequest === "user_input") {
    return { kind: "question", title: "A subagent asks you something", since, requestId: null };
  }
  if (request?.kind === "auth_refresh") {
    return { kind: "request", title: "Sign in to the provider again", since, requestId };
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return { kind: "request", title: "Review guest messages", since, requestId: null };
  }
  return null;
}

/** A proposed plan or a failed run: both stay until the user acts or the thread runs again. */
function returned(thread: EnvironmentThreadShell): Omit<Ask, "requestId"> | null {
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
  return null;
}

const compareNow = (left: CockpitItem, right: CockpitItem) =>
  Number(left.working) - Number(right.working) ||
  KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
  ms(left.since) - ms(right.since) ||
  left.key.localeCompare(right.key);

type Draft = Omit<CockpitItem, "key" | "until" | "snoozedBy">;

/**
 * Everything agents wait on from the user, and the user's own todos, in one pass over the
 * thread shells. `now` is the badge count and the cockpit's order.
 */
export function deriveCockpitQueue(input: CockpitQueueInput): CockpitQueue {
  const nowMs = ms(input.now);
  const snoozedUntil = new Map<string, string>();
  for (const { environmentId, snoozes } of input.snoozes) {
    for (const snooze of snoozes) {
      // The subscription does not re-send when a snooze ends.
      if (ms(snooze.snoozedUntil) > nowMs) {
        snoozedUntil.set(cockpitItemKey(environmentId, snooze.key), snooze.snoozedUntil);
      }
    }
  }
  const now: CockpitItem[] = [];
  const snoozed: CockpitItem[] = [];
  const place = (draft: Draft, threadSnoozedUntil: string | null) => {
    const key = cockpitItemKey(draft.environmentId, draft.taskKey);
    if (input.hiddenKeys?.has(key)) return;
    const taskUntil = snoozedUntil.get(key) ?? null;
    if (taskUntil !== null) {
      snoozed.push({ ...draft, key, until: taskUntil, snoozedBy: "task" });
    } else if (draft.notBefore !== null && ms(draft.notBefore) > nowMs) {
      snoozed.push({ ...draft, key, until: draft.notBefore, snoozedBy: "time" });
    } else if (threadSnoozedUntil !== null) {
      snoozed.push({ ...draft, key, until: threadSnoozedUntil, snoozedBy: "thread" });
    } else {
      now.push({ ...draft, key, until: null, snoozedBy: null });
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
      wait: null,
      where: null,
      notBefore: null,
      requestId: null,
    };
    const threadSnoozedUntil = effectiveSnoozed(thread, { now: input.now })
      ? thread.snoozedUntil
      : null;
    const ask = liveAsk(thread);
    if (ask !== null) {
      place(
        // A live ask holds its run, so the agent waits on it whatever its run status says.
        {
          ...base,
          ...ask,
          taskKey:
            ask.requestId === null
              ? taskThreadKey(thread.id)
              : taskRequestKey(thread.id, ask.requestId),
          working: false,
        },
        threadSnoozedUntil,
      );
    }
    const waiting = thread.waiting ?? null;
    for (const wait of waiting?.items ?? []) {
      place(
        {
          ...base,
          taskKey: taskWaitKey(thread.id, wait.id),
          kind: wait.kind,
          title: wait.summary,
          since: waiting?.setAt ?? thread.updatedAt,
          where: wait.where ?? null,
          notBefore: wait.notBefore ?? null,
          wait,
        },
        threadSnoozedUntil,
      );
    }
    if (ask !== null || waiting !== null || key === input.overviewThreadKey) continue;
    const back = returned(thread);
    if (back !== null) {
      place({ ...base, ...back, taskKey: taskThreadKey(thread.id) }, threadSnoozedUntil);
    }
  }

  for (const { environmentId, todos } of input.todos) {
    for (const todo of todos) {
      if (todo.completedAt !== null) continue;
      place(
        {
          taskKey: taskTodoKey(todo.id),
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
          requestId: null,
          wait: null,
          todo,
        },
        null,
      );
    }
  }

  return {
    now: now.sort(compareNow),
    snoozed: snoozed.sort(
      (left, right) => ms(left.until) - ms(right.until) || left.key.localeCompare(right.key),
    ),
  };
}
