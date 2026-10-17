import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { rankThreadSwitcherThreads } from "./ThreadSwitcher.logic";

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
