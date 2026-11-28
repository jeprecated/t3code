import {
  EnvironmentId,
  taskTodoKey,
  taskWaitKey,
  RunId,
  RuntimeRequestId,
  ThreadId,
  UserTodoId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadWait,
  type UserTodo,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import { presentThreadShell, type PendingSubagentRequest } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveCockpitQueue, type CockpitQueueInput } from "./cockpitQueue.ts";

const env = EnvironmentId.make("env-1");
const NOW = "2026-06-20T12:00:00.000Z";
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  subagentRequest: PendingSubagentRequest | null = null,
) {
  const threadId = ThreadId.make(id);
  return presentThreadShell(
    env,
    {
      ...v2ThreadShell,
      id: threadId,
      title: id,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      lastVisitedAt: at("2026-06-20T10:00:00.000Z"),
      ...overrides,
    },
    subagentRequest,
  );
}

const completed = (completedAt: string): Partial<OrchestrationV2ThreadShell> => ({
  latestRunId: RunId.make("run"),
  status: "completed",
  latestRunCompletedAt: at(completedAt),
});

const running: Partial<OrchestrationV2ThreadShell> = {
  latestRunId: RunId.make("run"),
  activeRunId: RunId.make("run"),
  status: "running",
  activityRunStatus: "running",
};

const ask = (
  kind: "command" | "user_input" | "auth_refresh",
  createdAt: string,
  title?: string,
): Partial<OrchestrationV2ThreadShell> => ({
  latestRunId: RunId.make("run"),
  activeRunId: RunId.make("run"),
  status: "waiting",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request"),
    kind,
    createdAt: at(createdAt),
    ...(title === undefined ? {} : { title }),
  },
});

const waits = (
  setAt: string,
  ...items: Array<Partial<OrchestrationV2ThreadWait> & { id: string }>
): Partial<OrchestrationV2ThreadShell> => ({
  ...completed("2026-06-20T09:00:00.000Z"),
  waiting: {
    setAt,
    items: items.map((item) => ({ kind: "decision" as const, summary: item.id, ...item })),
  },
});

const todo = (id: string, overrides: Partial<UserTodo> = {}): UserTodo => ({
  id: UserTodoId.make(id),
  title: id,
  createdBy: "user",
  createdAt: "2026-06-20T08:00:00.000Z",
  updatedAt: "2026-06-20T08:00:00.000Z",
  completedAt: null,
  ...overrides,
});

function derive(input: Partial<CockpitQueueInput>) {
  return deriveCockpitQueue({
    threads: [],
    todos: [],
    snoozes: [],
    now: NOW,
    delegatedUnderParent: new Set(),
    projectTitles: new Map(),
    ...input,
  });
}

const keys = (items: ReadonlyArray<{ key: string }>) => items.map((item) => item.key);

describe("deriveCockpitQueue", () => {
  it("lists live asks, each wait, plans, failures and open todos", () => {
    const queue = derive({
      threads: [
        shell("approve", ask("command", "2026-06-20T11:00:00.000Z")),
        shell("question", ask("user_input", "2026-06-20T11:00:00.000Z")),
        shell("titled", ask("user_input", "2026-06-20T11:30:00.000Z", "Which base branch?")),
        shell("auth", ask("auth_refresh", "2026-06-20T11:00:00.000Z")),
        shell(
          "waits",
          waits(
            "2026-06-20T09:30:00.000Z",
            { id: "pick", options: ["a", "b"] },
            { id: "run", kind: "manual_step" },
            { id: "look", kind: "review" },
          ),
        ),
        shell("done", completed("2026-06-20T11:00:00.000Z")),
        shell("settled", { ...completed("2026-06-20T11:00:00.000Z"), settledOverride: "settled" }),
        shell("plan", {
          ...completed("2026-06-20T09:00:00.000Z"),
          interactionMode: "plan",
          hasActionableProposedPlan: true,
        }),
        shell("failed", {
          ...completed("2026-06-20T09:00:00.000Z"),
          status: "failed",
          lastError: "Boom\nstack",
        }),
        shell("busy", running),
        shell("archived", { ...completed("2026-06-20T11:00:00.000Z"), archivedAt: at(NOW) }),
      ],
      todos: [{ environmentId: env, todos: [todo("call"), todo("old", { completedAt: NOW })] }],
      projectTitles: new Map([[`${env}:${v2ThreadShell.projectId}`, "Project"]]),
    });
    expect(queue.now.map((item) => [item.key, item.kind, item.title])).toEqual([
      ["env-1:request:approve:request", "approval", "Approve a command"],
      ["env-1:request:question:request", "question", "Answer the agent"],
      ["env-1:request:titled:request", "question", "Which base branch?"],
      ["env-1:wait:waits:pick", "decision", "pick"],
      ["env-1:wait:waits:run", "manual_step", "run"],
      ["env-1:request:auth:request", "request", "Sign in to the provider again"],
      ["env-1:thread:plan", "plan", "Review the plan"],
      ["env-1:wait:waits:look", "review", "look"],
      ["env-1:thread:failed", "fix", "Boom"],
      ["env-1:todo:call", "todo", "call"],
    ]);
    expect(queue.now[3]).toMatchObject({
      taskKey: "wait:waits:pick",
      projectTitle: "Project",
      threadTitle: "waits",
      since: "2026-06-20T09:30:00.000Z",
      wait: { options: ["a", "b"] },
    });
    expect(queue.now[0]?.requestId).toBe("request");
  });

  it("lists a subagent's ask once, on its parent", () => {
    const child = shell("child", {
      ...ask("command", "2026-06-20T11:00:00.000Z"),
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
    });
    const delegated = shell("delegated", ask("command", "2026-06-20T11:00:00.000Z"));
    const parent = shell("parent", running, "approval");
    const queue = derive({
      threads: [child, delegated, parent],
      delegatedUnderParent: new Set([threadKey({ environmentId: env, threadId: delegated.id })]),
    });
    expect(queue.now.map((item) => [item.key, item.title])).toEqual([
      ["env-1:thread:parent", "A subagent needs approval"],
    ]);
  });

  it("keeps plans and failures off the queue while the thread waits on something else", () => {
    const failed = { status: "failed" as const, lastError: "Boom" };
    const queue = derive({
      threads: [
        shell("waits", {
          ...waits("2026-06-20T09:30:00.000Z", { id: "pick" }),
          ...failed,
        }),
        shell("overview", { ...completed("2026-06-20T11:00:00.000Z"), ...failed }),
      ],
      overviewThreadKey: "env-1:overview",
    });
    expect(keys(queue.now)).toEqual(["env-1:wait:waits:pick"]);
  });

  it("holds task-snoozed, time-gated and thread-snoozed items apart from now", () => {
    const queue = derive({
      threads: [
        shell(
          "waits",
          waits(
            "2026-06-20T09:30:00.000Z",
            { id: "later", kind: "manual_step" },
            { id: "expired" },
            { id: "evening", kind: "manual_step", notBefore: "2026-06-20T18:00:00.000Z" },
            { id: "past", notBefore: "2026-06-20T11:00:00.000Z" },
            { id: "answered" },
          ),
        ),
        shell("snoozed", {
          ...waits("2026-06-20T09:30:00.000Z", { id: "pick" }),
          snoozedUntil: at("2026-06-20T15:00:00.000Z"),
          snoozedAt: at("2026-06-20T10:00:00.000Z"),
        }),
        shell("woke", {
          ...ask("command", "2026-06-20T11:00:00.000Z"),
          snoozedUntil: at("2026-06-20T15:00:00.000Z"),
          snoozedAt: at("2026-06-20T10:00:00.000Z"),
        }),
      ],
      todos: [
        {
          environmentId: env,
          todos: [todo("tomorrow", { notBefore: "2026-06-21T09:00:00.000Z" }), todo("home")],
        },
      ],
      snoozes: [
        {
          environmentId: env,
          snoozes: [
            {
              key: taskWaitKey("waits", "later"),
              snoozedUntil: "2026-06-20T13:00:00.000Z",
              snoozedAt: NOW,
            },
            {
              key: taskWaitKey("waits", "expired"),
              snoozedUntil: "2026-06-20T11:59:00.000Z",
              snoozedAt: NOW,
            },
            {
              key: taskTodoKey("home"),
              snoozedUntil: "2026-06-22T09:00:00.000Z",
              snoozedAt: NOW,
            },
          ],
        },
        // Another environment's snooze of the same key leaves this one alone.
        {
          environmentId: EnvironmentId.make("env-2"),
          snoozes: [
            {
              key: taskWaitKey("waits", "past"),
              snoozedUntil: "2026-06-20T13:00:00.000Z",
              snoozedAt: NOW,
            },
          ],
        },
      ],
      hiddenKeys: new Set(["env-1:wait:waits:answered"]),
    });
    expect(keys(queue.now)).toEqual([
      "env-1:request:woke:request",
      "env-1:wait:waits:expired",
      "env-1:wait:waits:past",
    ]);
    expect(queue.snoozed.map((item) => [item.key, item.until, item.snoozedBy])).toEqual([
      ["env-1:wait:waits:later", "2026-06-20T13:00:00.000Z", "task"],
      ["env-1:wait:snoozed:pick", "2026-06-20T15:00:00.000Z", "thread"],
      ["env-1:wait:waits:evening", "2026-06-20T18:00:00.000Z", "time"],
      ["env-1:todo:tomorrow", "2026-06-21T09:00:00.000Z", "time"],
      ["env-1:todo:home", "2026-06-22T09:00:00.000Z", "task"],
    ]);
  });

  it("puts idle threads before working ones, then kind, then the longest wait", () => {
    const queue = derive({
      threads: [
        shell("working", {
          ...running,
          waiting: {
            setAt: "2026-06-20T08:00:00.000Z",
            items: [{ id: "pick", kind: "decision", summary: "Pick" }],
          },
        }),
        shell("blocked-old", waits("2026-06-20T08:00:00.000Z", { id: "ci", kind: "blocked" })),
        shell("decision-new", waits("2026-06-20T11:00:00.000Z", { id: "pick" })),
        shell("decision-old", waits("2026-06-20T10:00:00.000Z", { id: "pick" })),
      ],
    });
    expect(keys(queue.now)).toEqual([
      "env-1:wait:decision-old:pick",
      "env-1:wait:decision-new:pick",
      "env-1:wait:blocked-old:ci",
      "env-1:wait:working:pick",
    ]);
    expect(queue.now.at(-1)?.working).toBe(true);
  });
});
