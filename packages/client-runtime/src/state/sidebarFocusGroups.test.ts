import { ClientSettingsSchema, type SidebarFocusGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compileSidebarFocusGroups,
  resolveSidebarFocusScope,
  sidebarFocusScopeIncludes,
  stepSidebarFocusScope,
  type SidebarFocusSubject,
} from "./sidebarFocusGroups.ts";

const decodeClientSettings = Schema.decodeSync(ClientSettingsSchema);

const emptyRule = {
  repositories: [],
  environments: [],
  providerInstances: [],
  branches: [],
  workspacePaths: [],
};

function group(
  id: string,
  rules: ReadonlyArray<Partial<SidebarFocusGroup["rules"][number]>>,
): SidebarFocusGroup {
  return { id, name: id, color: "teal", rules: rules.map((rule) => ({ ...emptyRule, ...rule })) };
}

function subject(overrides: Partial<SidebarFocusSubject> = {}): SidebarFocusSubject {
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

describe("compileSidebarFocusGroups", () => {
  it("matches repository globs case-insensitively and returns every matching group in order", () => {
    const match = compileSidebarFocusGroups([
      group("apps", [{ repositories: ["github.com/me/screen-gate"] }]),
      group("other", [{ repositories: ["github.com/elsewhere/*"] }]),
      group("mine", [{ repositories: ["GitHub.com/ME/*"] }]),
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
      compileSidebarFocusGroups([
        group("own", [{ repositories: ["github.com/me/t3code"] }]),
        group("upstream", [{ repositories: ["github.com/pingdotgg/*"] }]),
      ])(fork),
    ).toEqual(["own", "upstream"]);
  });

  it("requires every filled-in field of a rule and any rule of a group", () => {
    const match = compileSidebarFocusGroups([
      group("work", [
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
    const match = compileSidebarFocusGroups([
      group("blank", [{ repositories: ["  "], branches: [""] }]),
      group("empty", [{}]),
      group("none", []),
    ]);
    expect(match(subject())).toEqual([]);
  });

  it("treats regex characters in patterns literally", () => {
    const match = compileSidebarFocusGroups([group("dots", [{ branches: ["release.1"] }])]);
    expect(match(subject({ branch: "release.1" }))).toEqual(["dots"]);
    expect(match(subject({ branch: "releasex1" }))).toEqual([]);
  });

  it("matches repeated wildcards without pathological slowdowns", () => {
    const match = compileSidebarFocusGroups([
      group("stars", [{ workspacePaths: ["*".repeat(40) + "missing"] }]),
      group("middle", [{ branches: ["t3/**fix*"] }]),
    ]);
    // A backtracking matcher takes minutes on the 40-star pattern.
    expect(match(subject({ branch: "t3/quick-fix-sidebar" }))).toEqual(["middle"]);
    expect(match(subject({ branch: "t3/feature" }))).toEqual([]);
  });

  it("needs a project for repository and path rules", () => {
    const match = compileSidebarFocusGroups([
      group("repo", [{ repositories: ["*"] }]),
      group("path", [{ workspacePaths: ["*"] }]),
    ]);
    expect(match(subject({ project: null }))).toEqual([]);
    expect(match(subject({ project: { workspaceRoot: "/tmp/x" } }))).toEqual(["path"]);
  });
});

describe("focus scope", () => {
  const groups = [group("a", [{ branches: ["a"] }]), group("b", [{ branches: ["b"] }])];

  it("steps through everything, each group, and threads in no group, in both directions", () => {
    const forward = [];
    let scope = null as Parameters<typeof stepSidebarFocusScope>[0]["scope"];
    for (let index = 0; index < 4; index += 1) {
      scope = stepSidebarFocusScope({ scope, groups, direction: 1 });
      forward.push(scope);
    }
    expect(forward).toEqual([
      { type: "group", groupId: "a" },
      { type: "group", groupId: "b" },
      { type: "ungrouped" },
      null,
    ]);
    expect(stepSidebarFocusScope({ scope: null, groups, direction: -1 })).toEqual({
      type: "ungrouped",
    });
  });

  it("stays on everything when there are no groups", () => {
    expect(stepSidebarFocusScope({ scope: null, groups: [], direction: 1 })).toBeNull();
    expect(resolveSidebarFocusScope({ type: "ungrouped" }, [])).toBeNull();
  });

  it("falls back to everything when the focused group was deleted", () => {
    expect(resolveSidebarFocusScope({ type: "group", groupId: "gone" }, groups)).toBeNull();
    expect(
      stepSidebarFocusScope({ scope: { type: "group", groupId: "gone" }, groups, direction: 1 }),
    ).toEqual({ type: "group", groupId: "a" });
  });

  it("includes a thread in a group scope only when it matched that group", () => {
    expect(sidebarFocusScopeIncludes({ type: "group", groupId: "a" }, ["b", "a"])).toBe(true);
    expect(sidebarFocusScopeIncludes({ type: "group", groupId: "a" }, ["b"])).toBe(false);
    expect(sidebarFocusScopeIncludes({ type: "ungrouped" }, [])).toBe(true);
    expect(sidebarFocusScopeIncludes({ type: "ungrouped" }, ["a"])).toBe(false);
  });
});

describe("sidebarFocusGroups setting", () => {
  it("decodes partial groups and keeps the rest of the settings", () => {
    const settings = decodeClientSettings({
      sidebarThreadPreviewCount: 6,
      sidebarFocusGroups: [{ id: "g", name: "", color: "violet", rules: [{ branches: ["x"] }] }],
    });
    expect(settings.sidebarThreadPreviewCount).toBe(6);
    expect(settings.sidebarFocusGroups).toEqual([
      { id: "g", name: "", color: "violet", rules: [{ ...emptyRule, branches: ["x"] }] },
    ]);
  });
});
