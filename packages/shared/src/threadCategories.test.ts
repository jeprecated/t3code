import type {
  OrchestrationV2ThreadCategories,
  ThreadCategory,
  ThreadCategoryRule,
} from "@t3tools/contracts";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyThreadCategoryChanges,
  compileThreadCategoryRules,
  countSubstantiveUserMessages,
  pendingThreadCategorySuggestion,
  resolveThreadCategoryIds,
  threadCategoryChange,
  threadCategorySelectionChanges,
  threadCategorySuggestionCandidates,
  threadCategorySuggestionDue,
  type ThreadCategorySubject,
} from "./threadCategories.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const emptyRule = {
  repositories: [],
  environments: [],
  providerInstances: [],
  branches: [],
  workspacePaths: [],
};

function category(id: string, rules: ReadonlyArray<Partial<ThreadCategoryRule>>): ThreadCategory {
  return {
    id,
    name: id,
    description: "",
    color: "teal",
    rules: rules.map((rule) => ({ ...emptyRule, ...rule })),
  };
}

function subject(overrides: Partial<ThreadCategorySubject> = {}): ThreadCategorySubject {
  return {
    environmentId: "prism",
    providerInstanceId: "claudeAgent",
    branch: "main",
    project: {
      workspaceRoot: "/Users/me/Development/screen-gate",
      repositoryIdentity: {
        canonicalKey: "github.com/me/screen-gate",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:me/screen-gate.git",
        },
      },
    },
    ...overrides,
  };
}

describe("compileThreadCategoryRules", () => {
  it("matches repository globs case-insensitively and returns every matching category in order", () => {
    const match = compileThreadCategoryRules([
      category("apps", [{ repositories: ["github.com/me/screen-gate"] }]),
      category("other", [{ repositories: ["github.com/elsewhere/*"] }]),
      category("mine", [{ repositories: ["GitHub.com/ME/*"] }]),
    ]);
    expect(match(subject())).toEqual(["apps", "mine"]);
  });

  it("matches a fork by its own key or by its upstream", () => {
    const fork = subject({
      project: {
        workspaceRoot: "/src/t3code",
        repositoryIdentity: {
          canonicalKey: "github.com/me/t3code",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
          origin: { canonicalKey: "github.com/pingdotgg/t3code" },
        },
      },
    });
    expect(
      compileThreadCategoryRules([
        category("own", [{ repositories: ["github.com/me/t3code"] }]),
        category("upstream", [{ repositories: ["github.com/pingdotgg/*"] }]),
      ])(fork),
    ).toEqual(["own", "upstream"]);
  });

  it("requires every filled-in field of a rule and any rule of a category", () => {
    const match = compileThreadCategoryRules([
      category("work", [
        { environments: ["quartz"], branches: ["lego/*"] },
        { providerInstances: ["claudeAgent"], workspacePaths: ["*/Development/*"] },
      ]),
    ]);
    expect(match(subject())).toEqual(["work"]);
    expect(match(subject({ providerInstanceId: "codex" }))).toEqual([]);
    expect(
      match(subject({ environmentId: "quartz", providerInstanceId: null, branch: "lego/x/y" })),
    ).toEqual(["work"]);
    expect(
      match(subject({ environmentId: "quartz", providerInstanceId: null, branch: null })),
    ).toEqual([]);
  });

  it("never matches through blank or empty rules", () => {
    const match = compileThreadCategoryRules([
      category("blank", [{ repositories: ["  "], branches: [""] }]),
      category("empty", [{}]),
      category("none", []),
    ]);
    expect(match(subject())).toEqual([]);
  });

  it("treats regex characters in patterns literally", () => {
    const match = compileThreadCategoryRules([category("dots", [{ branches: ["release.1"] }])]);
    expect(match(subject({ branch: "release.1" }))).toEqual(["dots"]);
    expect(match(subject({ branch: "releasex1" }))).toEqual([]);
  });

  it("matches repeated wildcards without pathological slowdowns", () => {
    const match = compileThreadCategoryRules([
      category("stars", [{ workspacePaths: ["*".repeat(40) + "missing"] }]),
      category("middle", [{ branches: ["t3/**fix*"] }]),
    ]);
    // A backtracking matcher takes minutes on the 40-star pattern.
    expect(match(subject({ branch: "t3/quick-fix-sidebar" }))).toEqual(["middle"]);
    expect(match(subject({ branch: "t3/feature" }))).toEqual([]);
  });

  it("needs a project for repository and path rules", () => {
    const match = compileThreadCategoryRules([
      category("repo", [{ repositories: ["*"] }]),
      category("path", [{ workspacePaths: ["*"] }]),
    ]);
    expect(match(subject({ project: null }))).toEqual([]);
    expect(match(subject({ project: { workspaceRoot: "/tmp/x" } }))).toEqual(["path"]);
  });
});

describe("thread category membership", () => {
  const categories = ["self", "gpt", "mobile", "t3"].map((id) => category(id, []));
  const state = (
    overrides: Partial<OrchestrationV2ThreadCategories> = {},
  ): OrchestrationV2ThreadCategories => ({
    included: [],
    excluded: [],
    suggested: [],
    dismissed: [],
    reviewedMessageCount: 0,
    ...overrides,
  });

  it("inherits the categories a thread's rules give it", () => {
    expect(resolveThreadCategoryIds(categories, ["t3"], undefined)).toEqual(["t3"]);
    expect(resolveThreadCategoryIds(categories, ["t3"], state())).toEqual(["t3"]);
  });

  it("adds and removes categories for one thread, in category order", () => {
    const own = state({ included: ["mobile", "gpt"], excluded: ["t3"] });
    expect(resolveThreadCategoryIds(categories, ["t3"], own)).toEqual(["gpt", "mobile"]);
    expect(resolveThreadCategoryIds(categories, ["t3"], state({ excluded: ["t3"] }))).toEqual([]);
  });

  it("ignores categories that no longer exist", () => {
    expect(resolveThreadCategoryIds(categories, [], state({ included: ["gone"] }))).toEqual([]);
  });

  it("removes an inherited category by excluding it and restores it by inheriting again", () => {
    const removed = applyThreadCategoryChanges(
      undefined,
      [threadCategoryChange({ ruleCategoryIds: ["t3"], categoryId: "t3", member: false })],
      false,
    );
    expect(resolveThreadCategoryIds(categories, ["t3"], removed)).toEqual([]);
    const restored = applyThreadCategoryChanges(
      removed,
      [threadCategoryChange({ ruleCategoryIds: ["t3"], categoryId: "t3", member: true })],
      false,
    );
    expect(restored).toEqual(state());
    expect(resolveThreadCategoryIds(categories, ["t3"], restored)).toEqual(["t3"]);
  });

  it("keeps a thread in several categories at once", () => {
    const own = applyThreadCategoryChanges(
      undefined,
      [
        { categoryId: "mobile", state: "include" },
        { categoryId: "gpt", state: "include" },
      ],
      false,
    );
    expect(resolveThreadCategoryIds(categories, ["t3"], own)).toEqual(["gpt", "mobile", "t3"]);
  });

  it("applies an accepted suggestion and keeps when the thread was reviewed", () => {
    const pending = state({ suggested: ["mobile", "gpt"], reviewedMessageCount: 1 });
    const accepted = applyThreadCategoryChanges(
      pending,
      pendingThreadCategorySuggestion(categories, ["t3"], pending).map((entry) =>
        threadCategoryChange({ ruleCategoryIds: ["t3"], categoryId: entry.id, member: true }),
      ),
      true,
    );
    expect(accepted).toEqual(state({ included: ["gpt", "mobile"], reviewedMessageCount: 1 }));
  });

  it("dismisses what an edit leaves out of a suggestion and excludes what it unchecks", () => {
    const pending = state({ suggested: ["mobile", "gpt"] });
    const edited = applyThreadCategoryChanges(
      pending,
      threadCategorySelectionChanges({
        categories,
        ruleCategoryIds: ["t3"],
        state: pending,
        selectedIds: ["mobile"],
      }),
      true,
    );
    expect(edited).toEqual(state({ included: ["mobile"], excluded: ["t3"], dismissed: ["gpt"] }));
  });

  it("never offers dismissed, excluded, or current categories again", () => {
    const own = state({ dismissed: ["gpt"], excluded: ["self"], included: ["mobile"] });
    const effective = resolveThreadCategoryIds(categories, ["t3"], own);
    expect(threadCategorySuggestionCandidates(categories, effective, own)).toEqual([]);
    expect(
      threadCategorySuggestionCandidates(categories, ["t3"], undefined).map((entry) => entry.id),
    ).toEqual(["self", "gpt", "mobile"]);
    expect(
      pendingThreadCategorySuggestion(
        categories,
        ["t3"],
        state({ suggested: ["gpt", "gone", "t3"] }),
      ).map((entry) => entry.id),
    ).toEqual(["gpt"]);
  });

  it("suggests after the first substantive message and again as the thread doubles", () => {
    expect(threadCategorySuggestionDue(undefined, 0)).toBe(false);
    expect(threadCategorySuggestionDue(undefined, 1)).toBe(true);
    expect(threadCategorySuggestionDue(state({ reviewedMessageCount: 1 }), 2)).toBe(false);
    expect(threadCategorySuggestionDue(state({ reviewedMessageCount: 1 }), 3)).toBe(true);
    expect(threadCategorySuggestionDue(state({ reviewedMessageCount: 3 }), 6)).toBe(false);
    expect(threadCategorySuggestionDue(state({ reviewedMessageCount: 3 }), 7)).toBe(true);
    expect(
      countSubstantiveUserMessages([
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hello! What should we work on today?" },
        { role: "user", text: "Plan the Skool launch video" },
      ]),
    ).toBe(1);
  });
});

describe("threadCategories setting", () => {
  it("decodes partial categories and keeps the rest of the settings", () => {
    const settings = decodeServerSettings({
      addProjectBaseDirectory: "~/src",
      threadCategories: [{ id: "c", name: "", color: "violet", rules: [{ branches: ["x"] }] }],
    });
    expect(settings.addProjectBaseDirectory).toBe("~/src");
    expect(settings.threadCategories).toEqual([
      {
        id: "c",
        name: "",
        description: "",
        color: "violet",
        rules: [{ ...emptyRule, branches: ["x"] }],
      },
    ]);
    expect(decodeServerSettings({}).threadCategories).toEqual([]);
  });
});
