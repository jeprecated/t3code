import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { GitCommandError } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * Jujutsu workspaces for T3 worktrees. Since jj 0.46, `jj workspace add
 * --colocate` also registers the workspace as a git worktree, so T3 keeps
 * running git inside it and only creating and forgetting the workspace goes
 * through jj. That keeps T3's worktrees visible to `jj log` and `jj workspace
 * list` as well as `git worktree list`.
 */

const JJ_MIN_VERSION = [0, 46, 0] as const;

const ADD_TIMEOUT: Duration.Input = "300 seconds";
const DEFAULT_TIMEOUT: Duration.Input = "30 seconds";

// Without `git.abandon-unreachable-commits=false`, the git refs jj imports at
// the start of every command can abandon commits the user still wants.
const BASE_ARGS = [
  "--no-pager",
  "--color=never",
  "--config",
  "git.abandon-unreachable-commits=false",
] as const;

/**
 * Splits the `jujutsuCommand` setting into the program and the arguments that
 * precede jj's own, so `tick jj` runs Agent Tick's patched jj.
 */
export function parseJjCommand(setting: string): {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
} {
  const [program, ...args] = setting
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "");
  return program === undefined ? { program: "jj", args: [] } : { program, args };
}

/**
 * Agent Tick only lets `jj workspace add` create workspaces named
 * `<host>/...`, where host is `TICK_HOST` or the hostname's first label.
 */
export function jjWorkspaceHost(hostname: string, env: NodeJS.ProcessEnv): string {
  const tickHost = env.TICK_HOST?.trim();
  return tickHost ? tickHost : (hostname.split(".")[0] ?? hostname).toLowerCase();
}

/**
 * A jj revset naming `ref` as a single symbol, so characters such as `/`, `-`,
 * or `@` in a branch name are not read as revset operators.
 */
export function jjSymbolRevset(ref: string): string {
  return `"${ref.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

export interface JjWorkspace {
  readonly name: string;
  readonly root: string;
}

export function parseJjVersion(output: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedJjVersion(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < JJ_MIN_VERSION.length; index++) {
    if (version[index] !== JJ_MIN_VERSION[index]) {
      return version[index]! > JJ_MIN_VERSION[index]!;
    }
  }
  return true;
}

/** Parses `jj workspace list` rendered with {@link WORKSPACE_LIST_TEMPLATE}. */
export function parseJjWorkspaceList(output: string): ReadonlyArray<JjWorkspace> {
  return output.split("\n").flatMap((line) => {
    const separator = line.indexOf("\t");
    if (separator <= 0) return [];
    const root = line.slice(separator + 1);
    // A workspace jj cannot locate renders an empty root.
    return root === "" ? [] : [{ name: line.slice(0, separator), root }];
  });
}

const WORKSPACE_LIST_TEMPLATE = 'name ++ "\\t" ++ root ++ "\\n"';

// jj states the problem on its first `Error:` line, such as a workspace name
// that is already taken or a destination that is not empty.
const firstErrorLine = (stderr: string) => {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== "");
  return (lines.find((line) => line.startsWith("Error:")) ?? lines[0] ?? "").slice(0, 300);
};

export const make = Effect.fn("JjWorkspaces.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.make();

  // jj reports canonical roots. Resolve the parent, which still exists after
  // the workspace folder itself was removed, so a symlinked T3 home matches.
  const canonical = (target: string) =>
    fileSystem.realPath(path.dirname(target)).pipe(
      Effect.map((parent) => path.join(parent, path.basename(target))),
      Effect.orElseSucceed(() => path.resolve(target)),
    );

  const runJj = Effect.fn("JjWorkspaces.runJj")(function* (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeout?: Duration.Input;
  }) {
    const jjCommand = parseJjCommand(input.jjCommand ?? "jj");
    const args = [...jjCommand.args, ...BASE_ARGS, ...input.args];
    const failure = (detail: string, extra: { exitCode?: number; cause?: unknown } = {}) =>
      new GitCommandError({
        operation: input.operation,
        command: [jjCommand.program, ...jjCommand.args, ...input.args.slice(0, 2)].join(" "),
        cwd: input.cwd,
        argumentCount: args.length,
        detail,
        ...extra,
      });
    const result = yield* runner
      .run({
        command: jjCommand.program,
        args,
        cwd: input.cwd,
        timeout: input.timeout ?? DEFAULT_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProcessSpawnError"
            ? failure(`${jjCommand.program} is not installed or not on the server's PATH.`, {
                cause,
              })
            : failure("jj did not finish.", { cause }),
        ),
      );
    if (result.code !== 0) {
      return yield* failure(
        firstErrorLine(result.stderr) || "jj exited with an error.",
        typeof result.code === "number" ? { exitCode: result.code } : {},
      );
    }
    return result.stdout;
  });

  /**
   * The root of the colocated jj repository that owns `gitCommonDir`, or null
   * when the repository has no `.jj` beside its `.git`.
   */
  const repositoryRoot = Effect.fn("JjWorkspaces.repositoryRoot")(function* (gitCommonDir: string) {
    if (path.basename(gitCommonDir) !== ".git") return null;
    const root = path.dirname(gitCommonDir);
    const hasJj = yield* fileSystem
      .exists(path.join(root, ".jj"))
      .pipe(Effect.orElseSucceed(() => false));
    return hasJj ? root : null;
  });

  const requireSupportedVersion = Effect.fn("JjWorkspaces.requireSupportedVersion")(function* (
    operation: string,
    jjCommand: string,
    cwd: string,
  ) {
    const output = yield* runJj({ operation, jjCommand, cwd, args: ["--version"] });
    const version = parseJjVersion(output);
    if (version === null || !isSupportedJjVersion(version)) {
      return yield* new GitCommandError({
        operation,
        command: `${jjCommand} --version`,
        cwd,
        detail: `jj ${JJ_MIN_VERSION.join(".")} or newer is required to create jj workspaces (found ${output.trim() || "an unknown version"}).`,
      });
    }
  });

  /** `cwd` is any directory inside a workspace of the repository. */
  const list = (operation: string, jjCommand: string | undefined, cwd: string) =>
    runJj({
      operation,
      jjCommand,
      cwd,
      args: ["workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE],
    }).pipe(Effect.map(parseJjWorkspaceList));

  const forget = (operation: string, jjCommand: string | undefined, cwd: string, name: string) =>
    runJj({ operation, jjCommand, cwd, args: ["workspace", "forget", name] }).pipe(Effect.asVoid);

  /**
   * The commit `ref` (or, with `remote`, the remote bookmark `ref@remote`)
   * names in jj, or null when jj cannot resolve it to exactly one commit.
   * Agent Tick shares bookmarks across hosts but not git branches, so jj can
   * know a base that git lacks, or has only a stale copy of.
   */
  const resolveCommit = (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
    readonly ref: string;
    readonly remote?: string | undefined;
  }) =>
    runJj({
      ...input,
      args: [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        `exactly(${jjSymbolRevset(input.ref)}${input.remote === undefined ? "" : `@${jjSymbolRevset(input.remote)}`}, 1)`,
        "-T",
        "commit_id",
      ],
    }).pipe(
      Effect.map((stdout) => stdout.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  /**
   * `jj git fetch`. In Agent Tick repositories, where bookmarks are synced by
   * a daemon and there is no git remote, it waits until this host has the
   * server's latest state instead.
   */
  const gitFetch = (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
  }) => runJj({ ...input, args: ["git", "fetch"], timeout: ADD_TIMEOUT }).pipe(Effect.asVoid);

  /** Local bookmark names, each once even when the bookmark is conflicted. */
  const listBookmarks = (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
  }) =>
    runJj({
      ...input,
      args: [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "bookmarks()",
        "-T",
        'local_bookmarks.map(|b| b.name() ++ "\\n").join("")',
      ],
    }).pipe(Effect.map((stdout) => [...new Set(stdout.split("\n").filter((name) => name !== ""))]));

  /**
   * Adds a colocated workspace named `name` at `path`, checked out at
   * `commit`. A workspace of the same name whose directory is gone, such as
   * one removed with plain `git worktree remove`, is forgotten first so the
   * path can be recreated.
   */
  const add = Effect.fn("JjWorkspaces.add")(function* (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
    readonly name: string;
    readonly path: string;
    readonly commit: string;
  }) {
    const stale = (yield* list(input.operation, input.jjCommand, input.cwd)).find(
      (workspace) => workspace.name === input.name,
    );
    if (
      stale &&
      (yield* canonical(stale.root)) === (yield* canonical(input.path)) &&
      !(yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => true)))
    ) {
      yield* forget(input.operation, input.jjCommand, input.cwd, input.name);
    }
    // Unlike `git worktree add`, jj does not create missing parent folders.
    yield* fileSystem.makeDirectory(path.dirname(input.path), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: input.operation,
            command: "jj workspace add",
            cwd: input.cwd,
            detail: "Could not create the folder for the jj workspace.",
            cause,
          }),
      ),
    );
    yield* runJj({
      operation: input.operation,
      jjCommand: input.jjCommand,
      cwd: input.cwd,
      args: [
        "workspace",
        "add",
        "--colocate",
        "--name",
        input.name,
        "--sparse-patterns",
        "full",
        "-r",
        input.commit,
        input.path,
      ],
      timeout: ADD_TIMEOUT,
    });
  });

  /**
   * Forgets the workspace rooted at `path`, if jj has one. Removal
   * goes through git first so its dirty-tree check still applies; this only
   * drops jj's record of the workspace afterwards.
   */
  const forgetAt = Effect.fn("JjWorkspaces.forgetAt")(function* (input: {
    readonly operation: string;
    readonly jjCommand?: string | undefined;
    readonly cwd: string;
    readonly path: string;
  }) {
    const target = yield* canonical(input.path);
    for (const workspace of yield* list(input.operation, input.jjCommand, input.cwd)) {
      if ((yield* canonical(workspace.root)) === target) {
        return yield* forget(input.operation, input.jjCommand, input.cwd, workspace.name);
      }
    }
  });

  return {
    repositoryRoot,
    requireSupportedVersion,
    resolveCommit,
    gitFetch,
    listBookmarks,
    add,
    forgetAt,
  };
});
