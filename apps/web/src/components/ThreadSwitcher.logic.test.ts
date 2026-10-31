import { describe, expect, it } from "vite-plus/test";
import {
  wantedOlderSettledPages,
  type OlderSettled,
  type OlderSettledPages,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { rankThreadSwitcherThreads, threadSwitcherOlderSettledShelf } from "./ThreadSwitcher.logic";

const NOW = "2026-03-01T12:00:00.000Z";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({ id: ThreadId.make(id), title: id, ...overrides });
}

function rank(
  threads: ReadonlyArray<Thread>,
  options: {
    query?: string;
    includeSettled?: boolean;
    currentThreadKey?: string | null;
    repos?: Record<string, string>;
  } = {},
): string[] {
  return rankThreadSwitcherThreads(threads, {
    query: options.query ?? "",
    includeSettled: options.includeSettled ?? false,
    now: NOW,
    currentThreadKey: options.currentThreadKey ?? null,
    repoOf: (thread) => options.repos?.[thread.id] ?? null,
  }).map((thread) => thread.id);
}

describe("rankThreadSwitcherThreads", () => {
  it("leaves settled and snoozed threads out until settled threads are included", () => {
    const threads = [
      makeThread("active"),
      makeThread("settled", { settledOverride: "settled" }),
      makeThread("snoozed", { snoozedUntil: "2026-03-02T00:00:00.000Z" }),
      makeThread("woke", { snoozedUntil: "2026-03-01T00:00:00.000Z" }),
      makeThread("archived", { archivedAt: "2026-02-01T00:00:00.000Z" }),
    ];

    expect(rank(threads)).toEqual(["active", "woke"]);
    expect(rank(threads, { includeSettled: true })).toEqual([
      "active",
      "settled",
      "snoozed",
      "woke",
    ]);
  });

  it("ranks a name match above a repo match above a workspace match", () => {
    const threads = [
      makeThread("by-workspace", { title: "Fix crash", branch: "feat/sidebar" }),
      makeThread("by-repo", { title: "Fix layout" }),
      makeThread("by-name", { title: "Sidebar focus groups" }),
      makeThread("no-match", { title: "Release notes" }),
    ];

    expect(rank(threads, { query: "sidebar", repos: { "by-repo": "sidebar-kit" } })).toEqual([
      "by-name",
      "by-repo",
      "by-workspace",
    ]);
  });

  it("ranks a closer match in a later field above a fuzzy match in the name", () => {
    const threads = [
      makeThread("scattered", { title: "Diagnose Prism Provider Startup Failure" }),
      makeThread("repo", { title: "Improve thread updates" }),
    ];

    expect(rank(threads, { query: "driver", repos: { scattered: "nix", repo: "driver" } })).toEqual(
      ["repo", "scattered"],
    );
  });

  it("matches fuzzily and needs every word to match some field", () => {
    const threads = [
      makeThread("t3", { title: "Thread switcher" }),
      makeThread("other", { title: "Thread switcher" }),
    ];
    const repos = { t3: "t3code", other: "mono-nix" };

    expect(rank(threads, { query: "thsw", repos })).toEqual(["t3", "other"]);
    expect(rank(threads, { query: "switcher t3code", repos })).toEqual(["t3"]);
  });

  it("matches the worktree folder name but not the rest of its path", () => {
    const threads = [makeThread("wt", { worktreePath: "/home/me/worktrees/t3-f31ecf88" })];

    expect(rank(threads, { query: "f31ecf" })).toEqual(["wt"]);
    expect(rank(threads, { query: "home" })).toEqual([]);
  });

  it("sinks the current thread to the end so Enter jumps away from it", () => {
    const threads = [makeThread("current"), makeThread("next")];
    const currentThreadKey = `${threads[0]!.environmentId}:current`;

    expect(rank(threads, { currentThreadKey })).toEqual(["next", "current"]);
    expect(rank(threads, { query: "current", currentThreadKey })).toEqual(["current"]);
  });
});

describe("threadSwitcherOlderSettledShelf", () => {
  const environmentId = EnvironmentId.make("environment-test");
  const PAGE_SIZE = 25;
  const at = (index: number) => new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString();

  // Shells hold the active threads and the newest settled ones; the server pages the older
  // settled ones, newest first, 25 at a time.
  const shellThreads = [
    makeThread("active", { title: "Release notes" }),
    makeThread("recent-settled", { title: "Thread switcher polish", settledOverride: "settled" }),
  ];
  const olderThreads = Array.from({ length: 130 }, (_, index) => {
    if (index === 80) return makeThread("older-switcher", { title: "Thread switcher" });
    if (index === 110) {
      return makeThread("older-worktree", {
        title: "Fix the build",
        worktreePath: "/home/me/worktrees/t3-f31ecf88",
      });
    }
    return makeThread(`older-${index}`, {
      title: `Older thread ${index}`,
      worktreePath: `/home/me/worktrees/t3-${index.toString(16).padStart(8, "0")}`,
    });
  }).map((thread) => ({ ...thread, settledOverride: "settled" as const }));
  const older: OlderSettled = {
    before: at(-1),
    beforeMs: Date.parse(at(-1)),
    counts: new Map([[olderThreads[0]!.projectId, olderThreads.length]]),
  };

  // Drives upstream's page loading as useOlderSettledShelfGrowth does, over the switcher's shelf,
  // until it asks for no more pages, and returns the rows those pages mount.
  function loadedOlderThreads(includeSettled: boolean): Thread[] {
    const shelf = threadSwitcherOlderSettledShelf([environmentId], includeSettled);
    const pagesOf = (count: number): OlderSettledPages => ({
      reads: [],
      frontier:
        count * PAGE_SIZE >= olderThreads.length
          ? null
          : count === 0
            ? { settledAt: older.before }
            : { settledAt: at(count * PAGE_SIZE - 1), threadId: ThreadId.make("t") },
      status: "ready",
    });
    let requested: ReadonlyMap<EnvironmentId, number> = new Map();
    for (;;) {
      const next = wantedOlderSettledPages({
        requested,
        environments: new Map(
          shelf.scopes.map((scope) => [
            scope.environmentId,
            { older, pages: pagesOf(requested.get(scope.environmentId) ?? 0) },
          ]),
        ),
        listedCount: 0,
        // useOlderSettledShelf shows nothing while the shelf is collapsed.
        visibleCount: shelf.expanded ? shelf.visibleCount : 0,
      });
      if (next === requested) break;
      requested = next;
    }
    return olderThreads.slice(0, (requested.get(environmentId) ?? 0) * PAGE_SIZE);
  }

  const queries = ["thsw", "f31ecf", "older thread", ""];

  it("finds older settled threads the shells leave out, as if every thread were loaded", () => {
    expect(rank(shellThreads, { query: "thsw", includeSettled: true })).toEqual(["recent-settled"]);
    expect(rank(shellThreads, { query: "f31ecf", includeSettled: true })).toEqual([]);

    const loaded = [...shellThreads, ...loadedOlderThreads(true)];
    expect(loaded).toHaveLength(shellThreads.length + olderThreads.length);
    expect(rank(loaded, { query: "thsw", includeSettled: true })).toContain("older-switcher");
    expect(rank(loaded, { query: "f31ecf", includeSettled: true })).toEqual(["older-worktree"]);
    for (const query of queries) {
      expect(rank(loaded, { query, includeSettled: true })).toEqual(
        rank([...shellThreads, ...olderThreads], { query, includeSettled: true }),
      );
    }
  });

  it("loads nothing while settled threads are hidden", () => {
    expect(loadedOlderThreads(false)).toEqual([]);
  });
});
