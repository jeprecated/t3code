import {
  EnvironmentId,
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
import {
  deriveYouQueue,
  nextYouQueueItem,
  youQueueTriageTarget,
  type YouQueueInput,
} from "./youQueue.ts";

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
): Partial<OrchestrationV2ThreadShell> => ({
  latestRunId: RunId.make("run"),
  activeRunId: RunId.make("run"),
  status: "waiting",
  pendingRuntimeRequest: { id: RuntimeRequestId.make("request"), kind, createdAt: at(createdAt) },
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

function derive(input: Partial<YouQueueInput>) {
  return deriveYouQueue({
    threads: [],
    todos: [],
    now: NOW,
    notHereKeys: new Set(),
    delegatedUnderParent: new Set(),
    projectTitles: new Map(),
    ...input,
  });
}

const keys = (items: ReadonlyArray<{ key: string }>) => items.map((item) => item.key);

describe("deriveYouQueue", () => {
  it("lists live asks, each wait, returned threads and open todos", () => {
    const queue = derive({
      threads: [
        shell("approve", ask("command", "2026-06-20T11:00:00.000Z")),
        shell("question", ask("user_input", "2026-06-20T11:00:00.000Z")),
        shell("auth", ask("auth_refresh", "2026-06-20T11:00:00.000Z")),
        shell(
          "waits",
          waits(
            "2026-06-20T09:30:00.000Z",
            { id: "pick", options: ["a", "b"] },
            { id: "run", kind: "manual_step" },
          ),
        ),
        shell("done", completed("2026-06-20T11:00:00.000Z")),
        shell("seen", completed("2026-06-20T09:00:00.000Z")),
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
      ["env-1:approve:ask", "approval", "Approve a command"],
      ["env-1:question:ask", "question", "Answer the agent"],
      ["env-1:waits:wait:pick", "decision", "pick"],
      ["env-1:waits:wait:run", "manual_step", "run"],
      ["env-1:auth:ask", "request", "Sign in to the provider again"],
      ["env-1:plan:returned", "plan", "Review the plan"],
      ["env-1:done:returned", "review", "Review the result"],
      ["env-1:failed:returned", "fix", "Boom"],
    ]);
    expect(queue.now[2]).toMatchObject({
      projectTitle: "Project",
      threadTitle: "waits",
      since: "2026-06-20T09:30:00.000Z",
      wait: { options: ["a", "b"] },
    });
    expect(keys(queue.todos)).toEqual(["env-1:todo:call"]);
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
      ["env-1:parent:ask", "A subagent needs approval"],
    ]);
  });

  it("keeps returned threads off the queue while they wait on something else", () => {
    const queue = derive({
      threads: [
        shell("waits", {
          ...waits("2026-06-20T09:30:00.000Z", { id: "pick" }),
          ...completed("2026-06-20T11:00:00.000Z"),
        }),
        shell("overview", completed("2026-06-20T11:00:00.000Z")),
      ],
      overviewThreadKey: "env-1:overview",
    });
    expect(keys(queue.now)).toEqual(["env-1:waits:wait:pick"]);
  });

  it("keeps a seen completion listed for the thread opened from the queue", () => {
    const seen = shell("seen", completed("2026-06-20T09:00:00.000Z"));
    expect(derive({ threads: [seen] }).now).toEqual([]);
    expect(keys(derive({ threads: [seen], retainedThreadKey: "env-1:seen" }).now)).toEqual([
      "env-1:seen:returned",
    ]);
  });

  it("groups not-here, time-gated and snoozed items apart from now", () => {
    const queue = derive({
      threads: [
        shell(
          "waits",
          waits(
            "2026-06-20T09:30:00.000Z",
            { id: "phone", kind: "manual_step", where: "iPhone in hand" },
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
          todos: [
            todo("tomorrow", { notBefore: "2026-06-21T09:00:00.000Z" }),
            todo("office"),
            todo("home"),
          ],
        },
      ],
      notHereKeys: new Set(["env-1:waits:wait:phone", "env-1:todo:office"]),
      hiddenKeys: new Set(["env-1:waits:wait:answered"]),
    });
    expect(keys(queue.now)).toEqual(["env-1:woke:ask", "env-1:waits:wait:past"]);
    expect(queue.later.map((item) => [item.key, item.notBefore])).toEqual([
      ["env-1:snoozed:wait:pick", "2026-06-20T15:00:00.000Z"],
      ["env-1:waits:wait:evening", "2026-06-20T18:00:00.000Z"],
      ["env-1:todo:tomorrow", "2026-06-21T09:00:00.000Z"],
    ]);
    expect(keys(queue.elsewhere)).toEqual(["env-1:waits:wait:phone", "env-1:todo:office"]);
    expect(keys(queue.todos)).toEqual(["env-1:todo:home"]);
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
      "env-1:decision-old:wait:pick",
      "env-1:decision-new:wait:pick",
      "env-1:blocked-old:wait:ci",
      "env-1:working:wait:pick",
    ]);
    expect(queue.now.at(-1)?.working).toBe(true);
  });
});

describe("triage", () => {
  const queue = derive({
    threads: [
      shell("a", waits("2026-06-20T08:00:00.000Z", { id: "one" }, { id: "two" })),
      shell("b", waits("2026-06-20T09:00:00.000Z", { id: "one" })),
      shell("c", waits("2026-06-20T10:00:00.000Z", { id: "one" })),
    ],
  }).now;

  it("steps to the next thread's item and wraps", () => {
    expect(nextYouQueueItem(queue, "env-1:a")?.key).toBe("env-1:b:wait:one");
    expect(nextYouQueueItem(queue, "env-1:c")?.key).toBe("env-1:a:wait:one");
    expect(nextYouQueueItem(queue, null)?.key).toBe("env-1:a:wait:one");
    expect(nextYouQueueItem(queue.slice(0, 2), "env-1:a")).toBeNull();
  });

  it("advances only once the open thread's last item leaves", () => {
    const withoutOne = queue.filter((item) => item.key !== "env-1:a:wait:one");
    expect(youQueueTriageTarget(queue, withoutOne, "env-1:a")).toBeNull();
    const withoutA = queue.filter((item) => item.threadKey !== "env-1:a");
    expect(youQueueTriageTarget(queue, withoutA, "env-1:a")?.key).toBe("env-1:b:wait:one");
    const withoutAB = withoutA.filter((item) => item.threadKey !== "env-1:b");
    expect(youQueueTriageTarget(queue, withoutAB, "env-1:a")?.key).toBe("env-1:c:wait:one");
    expect(youQueueTriageTarget(withoutA, withoutA, "env-1:a")).toBeNull();
  });
});
