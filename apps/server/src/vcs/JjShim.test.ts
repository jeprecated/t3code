// @effect-diagnostics nodeBuiltinImport:off - runs the generated script to check its quoting.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureJjShim, jjShimScript, needsJjShim } from "./JjShim.ts";

describe("jj shim", () => {
  it("is only needed for a command other than plain jj", () => {
    assert.equal(needsJjShim("jj"), false);
    assert.equal(needsJjShim("  jj "), false);
    assert.equal(needsJjShim("tick jj"), true);
    assert.equal(needsJjShim("jj --config x=1"), true);
    assert.equal(needsJjShim("/opt/jj/bin/jj"), true);
  });

  it("quotes the command and passes the agent's arguments through", () => {
    const script = jjShimScript("/bin/sh", ["-c", 'printf "%s\\n" "$@"', "argv0", "it's", "$HOME"]);
    assert.equal(
      script,
      `#!/bin/sh\nexec '/bin/sh' '-c' 'printf "%s\\n" "$@"' 'argv0' 'it'\\''s' '$HOME' "$@"\n`,
    );
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script, "jj", "log", "-r", "@ x"], {
      encoding: "utf8",
    });
    assert.deepEqual(result.stdout.trimEnd().split("\n"), ["it's", "$HOME", "log", "-r", "@ x"]);
  });

  it.effect("writes an executable shim once, resolving the program on PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-shim-" });

      const directory = yield* ensureJjShim(stateDir, "sh -c");
      const shim = path.join(directory!, "jj");
      const script = yield* fileSystem.readFileString(shim);
      assert.match(script, /^#!\/bin\/sh\nexec '\/[^']*\/sh' '-c' "\$@"\n$/);
      assert.equal(((yield* fileSystem.stat(shim)).mode & 0o111) !== 0, true);
      const result = NodeChildProcess.spawnSync(shim, ["echo shimmed"], { encoding: "utf8" });
      assert.equal(result.stdout, "shimmed\n");

      assert.equal(yield* ensureJjShim(stateDir, "sh -c"), directory);
      assert.deepEqual(yield* fileSystem.readDirectory(directory!), ["jj"]);
      assert.equal(yield* ensureJjShim(stateDir, "no-such-program-for-t3 jj"), null);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
