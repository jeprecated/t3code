import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import { parseJjCommand } from "./JjWorkspaces.ts";

/**
 * Agents run `jj` from their PATH, but some repositories need another jj, such
 * as Agent Tick's `tick jj` (the system jj refuses those repositories). When
 * the `jujutsuCommand` setting names one, threads in a jj workspace get a
 * directory holding a `jj` script that runs it first on their PATH.
 */

/** False for plain `jj`, which needs no shim. */
export function needsJjShim(jjCommand: string): boolean {
  const { program, args } = parseJjCommand(jjCommand);
  return program !== "jj" || args.length > 0;
}

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** `program` is absolute: a bare `jj` would find the shim itself on PATH. */
export function jjShimScript(program: string, args: ReadonlyArray<string>): string {
  return `#!/bin/sh\nexec ${[program, ...args].map(shellQuote).join(" ")} "$@"\n`;
}

/**
 * Writes `<stateDir>/jj-shim/jj` for `jjCommand` unless it is already current,
 * and returns its directory, or null when the server cannot find the program.
 * The program is resolved on the server's PATH each time, so a moved binary
 * rewrites the shim on the next session.
 */
export const ensureJjShim = Effect.fn("JjShim.ensure")(function* (
  stateDir: string,
  jjCommand: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { program, args } = parseJjCommand(jjCommand);
  const resolved = yield* resolveCommandPath(program);
  if (resolved === null) return null;
  const script = jjShimScript(resolved, args);
  const directory = path.join(stateDir, "jj-shim");
  const shim = path.join(directory, "jj");
  const current = yield* fileSystem.readFileString(shim).pipe(Effect.orElseSucceed(() => null));
  if (current === script) return directory;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  // Rename into place, so a session starting now never runs half a script.
  const staged = `${shim}.${yield* Random.nextInt}.tmp`;
  yield* fileSystem.writeFileString(staged, script, { mode: 0o755 });
  yield* fileSystem.chmod(staged, 0o755);
  yield* fileSystem.rename(staged, shim);
  return directory;
});
