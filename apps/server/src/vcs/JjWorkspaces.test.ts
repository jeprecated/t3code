// @effect-diagnostics nodeBuiltinImport:off - probes jj synchronously at import to decide which tests to skip.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { isSupportedJjVersion, parseJjVersion, parseJjWorkspaceList } from "./JjWorkspaces.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-workspaces-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const installedJj = parseJjVersion(
  NodeChildProcess.spawnSync("jj", ["--version"], { encoding: "utf8" }).stdout ?? "",
);
const hasSupportedJj = installedJj !== null && isSupportedJjVersion(installedJj);

// The driver's jj inherits this environment. Keep the developer's jj config,
// such as commit signing, out of the tests.
process.env.JJ_CONFIG = NodeOS.devNull;
process.env.JJ_USER = "Test";
process.env.JJ_EMAIL = "test@test.com";

describe("jj output parsing", () => {
  it("reads the version from jj --version", () => {
    assert.deepEqual(parseJjVersion("jj 0.46.0\n"), [0, 46, 0]);
    assert.deepEqual(parseJjVersion("jj 0.47.1-abcdef\n"), [0, 47, 1]);
    assert.equal(parseJjVersion("command not found"), null);
  });

  it("requires jj 0.46 for colocated workspaces", () => {
    assert.equal(isSupportedJjVersion([0, 45, 9]), false);
    assert.equal(isSupportedJjVersion([0, 46, 0]), true);
    assert.equal(isSupportedJjVersion([0, 100, 0]), true);
    assert.equal(isSupportedJjVersion([1, 0, 0]), true);
  });

  it("lists named workspaces and skips ones jj cannot locate", () => {
    assert.deepEqual(parseJjWorkspaceList("default\t/repo\nt3-abc\t/wt/t3-abc\nlost\t\n"), [
      { name: "default", root: "/repo" },
      { name: "t3-abc", root: "/wt/t3-abc" },
    ]);
  });
});

it.layer(layerTest)("jj workspaces", (it) => {
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    GitVcsDriver.GitVcsDriver.pipe(
      Effect.flatMap((driver) =>
        driver.execute({ operation: "JjWorkspaces.test.git", cwd, args, timeoutMs: 10_000 }),
      ),
      Effect.map((result) => result.stdout.trim()),
    );

  const makeRepo = (options: { readonly jj: boolean }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-workspaces-" });
      const cwd = path.join(base, "repo");
      yield* fileSystem.makeDirectory(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "# test\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "initial commit"]);
      const jj = (args: ReadonlyArray<string>) => {
        const result = NodeChildProcess.spawnSync("jj", ["--no-pager", ...args], {
          cwd,
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      if (options.jj) jj(["git", "init", "--colocate"]);
      return { cwd, worktrees: path.join(base, "worktrees"), jj };
    });

  const workspaceNames = (jj: (args: ReadonlyArray<string>) => string) =>
    jj(["workspace", "list", "-T", 'name ++ "\\n"']).trim().split("\n");

  it.effect("refuses jj workspaces in a repository without .jj", () =>
    Effect.gen(function* () {
      const { cwd, worktrees } = yield* makeRepo({ jj: false });
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreePath = path.join(worktrees, "feature");

      const error = yield* driver
        .createWorktree(
          { cwd, path: worktreePath, refName: "HEAD", newRefName: "feature" },
          { jujutsu: true },
        )
        .pipe(Effect.flip);

      assert.include(error.detail, "no .jj folder");
      assert.equal(yield* fileSystem.exists(worktreePath), false);
      assert.notInclude(yield* driver.listLocalBranchNames(cwd), "feature");
    }),
  );

  it.effect.skipIf(!hasSupportedJj)(
    "creates a worktree that git and jj both list, then removes it from both",
    () =>
      Effect.gen(function* () {
        const { cwd, worktrees, jj } = yield* makeRepo({ jj: true });
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(worktrees, "t3-feature");

        const created = yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: "HEAD", newRefName: "t3/feature" },
          { jujutsu: true },
        );

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "t3/feature");
        assert.include(yield* git(cwd, ["worktree", "list"]), worktreePath);
        assert.include(workspaceNames(jj), "t3-feature");

        // Git commits in the workspace land on the branch jj sees.
        yield* fileSystem.writeFileString(path.join(worktreePath, "agent.txt"), "work\n");
        yield* git(worktreePath, ["add", "agent.txt"]);
        yield* git(worktreePath, ["commit", "-m", "agent work"]);
        assert.equal(
          jj(["log", "--no-graph", "-r", "t3/feature", "-T", "description.first_line()"]),
          "agent work",
        );

        yield* driver.removeWorktree({ cwd, path: worktreePath });

        assert.equal(yield* fileSystem.exists(worktreePath), false);
        assert.notInclude(yield* git(cwd, ["worktree", "list"]), worktreePath);
        assert.notInclude(workspaceNames(jj), "t3-feature");
      }),
  );

  it.effect.skipIf(!hasSupportedJj)(
    "recreates a workspace at a path git removed without telling jj",
    () =>
      Effect.gen(function* () {
        const { cwd, worktrees, jj } = yield* makeRepo({ jj: true });
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(worktrees, "t3-resume");

        yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: "HEAD", newRefName: "t3/resume" },
          { jujutsu: true },
        );
        // Storage cleanup and users remove worktrees with plain git.
        yield* git(cwd, ["worktree", "remove", worktreePath]);
        assert.include(workspaceNames(jj), "t3-resume");

        yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: "t3/resume" },
          { jujutsu: true },
        );

        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "t3/resume");
        assert.include(workspaceNames(jj), "t3-resume");
      }),
  );
});
