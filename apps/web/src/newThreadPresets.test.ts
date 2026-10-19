import type { NewThreadPreset } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commandForNewThreadPreset,
  describeNewThreadPreset,
  newThreadPresetIdFromCommand,
  resolveNewThreadPresetStart,
  saveNewThreadPreset,
} from "./newThreadPresets";

const opus = {
  instanceId: ProviderInstanceId.make("claude-cliproxy"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const sol = {
  instanceId: ProviderInstanceId.make("codex-cliproxy"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
};

describe("new-thread presets", () => {
  it("round-trips preset ids through keybinding commands", () => {
    expect(newThreadPresetIdFromCommand(commandForNewThreadPreset("quick"))).toBe("quick");
    expect(newThreadPresetIdFromCommand("script.quick.run")).toBeNull();
  });

  it("derives a keybinding-safe id from a new preset's name", () => {
    const presets = saveNewThreadPreset([], {
      name: "  Opus Worktree ",
      modelSelection: opus,
      project: "current",
      envMode: "worktree",
      startFromOrigin: true,
    });
    expect(presets).toEqual([
      {
        id: "opus-worktree",
        name: "Opus Worktree",
        modelSelection: opus,
        project: "current",
        envMode: "worktree",
        startFromOrigin: true,
      },
    ]);
  });

  it("replaces a same-named preset in place so its shortcut keeps working", () => {
    const existing: ReadonlyArray<NewThreadPreset> = [
      { id: "quick", name: "Quick", modelSelection: opus, project: "none" },
      { id: "other", name: "Other", modelSelection: opus, project: "current" },
    ];
    const presets = saveNewThreadPreset(existing, {
      name: "quick",
      modelSelection: sol,
      project: "none",
    });
    expect(presets).toEqual([
      { id: "quick", name: "quick", modelSelection: sol, project: "none" },
      existing[1],
    ]);
  });

  it("keeps ids unique when names differ only in punctuation", () => {
    const first = saveNewThreadPreset([], { name: "Quick!", modelSelection: sol, project: "none" });
    const second = saveNewThreadPreset(first, {
      name: "Quick?",
      modelSelection: sol,
      project: "none",
    });
    expect(second.map((preset) => preset.id)).toEqual(["quick", "quick-2"]);
  });

  it("names a pinned preset's project and machine instead of the current project", () => {
    const pinned: NewThreadPreset = {
      id: "fork",
      name: "Fork",
      modelSelection: { ...opus, options: [] },
      project: "pinned",
      environmentId: EnvironmentId.make("lattice"),
      projectId: ProjectId.make("t3-code-fork"),
      envMode: "worktree",
      startFromOrigin: true,
    };
    expect(describeNewThreadPreset(pinned, "T3 Code Fork on Lattice")).toBe(
      "claude-opus-5-5 · T3 Code Fork on Lattice, new worktree from origin",
    );
    expect(describeNewThreadPreset({ ...pinned, project: "current" }, null)).toBe(
      "claude-opus-5-5 · current project, new worktree from origin",
    );
  });
});

describe("new-thread preset start", () => {
  const lattice = EnvironmentId.make("lattice");
  const prism = EnvironmentId.make("prism");
  const repository = (canonicalKey: string, rootPath: string) => ({
    canonicalKey,
    rootPath,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: canonicalKey },
  });
  const project = (
    environmentId: EnvironmentId,
    id: string,
    workspaceRoot: string,
    repositoryIdentity: ReturnType<typeof repository> | null,
  ) => ({ environmentId, id: ProjectId.make(id), workspaceRoot, repositoryIdentity });
  const ref = (target: { environmentId: EnvironmentId; id: ProjectId }) => ({
    environmentId: target.environmentId,
    projectId: target.id,
  });

  const latticeApp = project(
    lattice,
    "lattice-app",
    "/home/jmo/mono/apps/web",
    repository("github.com/jmo/mono", "/home/jmo/mono"),
  );
  const prismRoot = project(
    prism,
    "prism-root",
    "/Users/jmo/mono",
    repository("github.com/jmo/mono", "/Users/jmo/mono"),
  );
  const prismApp = project(
    prism,
    "prism-app",
    "/Users/jmo/mono/apps/web",
    repository("github.com/jmo/mono", "/Users/jmo/mono"),
  );
  const latticeOther = project(
    lattice,
    "lattice-other",
    "/home/jmo/other",
    repository("github.com/jmo/other", "/home/jmo/other"),
  );
  const latticeScratch = project(lattice, "lattice-scratch", "/home/jmo/.t3/scratch", null);
  const projects = [latticeApp, latticeOther, latticeScratch, prismRoot, prismApp];

  const lego: NewThreadPreset = {
    id: "lego-work",
    name: "Lego Work",
    modelSelection: opus,
    project: "current",
    environmentId: prism,
    envMode: "worktree",
  };
  const start = (
    preset: NewThreadPreset,
    current: (typeof projects)[number] | null,
    options: { connected?: ReadonlyArray<EnvironmentId>; scratch?: boolean } = {},
  ) =>
    resolveNewThreadPresetStart({
      preset,
      currentProjectRef: current ? ref(current) : null,
      currentProject: current,
      currentProjectIsScratch: options.scratch ?? false,
      currentEnvironmentId: current?.environmentId ?? null,
      defaultProjectRef: ref(latticeOther),
      projects,
      isConnected: (environmentId) =>
        (options.connected ?? [lattice, prism]).includes(environmentId),
    });

  it("keeps an unpinned preset on the current project, or the first project from no project", () => {
    const { environmentId: _, ...unpinned } = lego;
    expect(start(unpinned, latticeApp)).toEqual({ kind: "project", projectRef: ref(latticeApp) });
    expect(start(unpinned, latticeScratch, { scratch: true })).toEqual({
      kind: "project",
      projectRef: ref(latticeOther),
    });
    expect(
      start({ id: "s", name: "S", modelSelection: opus, project: "none" }, latticeApp),
    ).toEqual({ kind: "scratch", environmentId: lattice });
  });

  it("uses the current project when it is already on the pinned machine", () => {
    expect(start(lego, prismRoot)).toEqual({ kind: "project", projectRef: ref(prismRoot) });
  });

  it("swaps a project on another machine for the same repository folder on the pinned one", () => {
    expect(start(lego, latticeApp)).toEqual({ kind: "project", projectRef: ref(prismApp) });
    expect(start(lego, { ...latticeApp, workspaceRoot: "/home/jmo/mono/docs" })).toEqual({
      kind: "project",
      projectRef: ref(prismRoot),
    });
  });

  it("starts without a project on the pinned machine when it has no matching repository", () => {
    expect(start(lego, latticeOther)).toEqual({ kind: "scratch", environmentId: prism });
    expect(start(lego, latticeScratch, { scratch: true })).toEqual({
      kind: "scratch",
      environmentId: prism,
    });
    expect(start(lego, null)).toEqual({ kind: "scratch", environmentId: prism });
    expect(
      start(
        { id: "s", name: "S", modelSelection: opus, project: "none", environmentId: prism },
        latticeApp,
      ),
    ).toEqual({ kind: "scratch", environmentId: prism });
  });

  it("refuses to start on another machine while the pinned one is offline", () => {
    const offline = { connected: [lattice] };
    const unavailable = { kind: "machine-unavailable", environmentId: prism };
    expect(start(lego, latticeApp, offline)).toEqual(unavailable);
    expect(
      start(
        { id: "s", name: "S", modelSelection: opus, project: "none", environmentId: prism },
        null,
        offline,
      ),
    ).toEqual(unavailable);
    expect(
      start(
        { ...lego, project: "pinned", environmentId: prism, projectId: prismRoot.id },
        latticeApp,
        offline,
      ),
    ).toEqual(unavailable);
  });

  it("describes a machine-pinned current-project preset", () => {
    expect(describeNewThreadPreset({ ...lego, modelSelection: sol }, "Prism")).toBe(
      "gpt-6.1-sol · xhigh · current project on Prism, new worktree",
    );
  });
});
