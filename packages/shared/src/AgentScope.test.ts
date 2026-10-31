// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  AGENT_OOM_SCORE_ADJ,
  agentScopeCommand,
  agentScopeLauncherScript,
  withPathPrefix,
} from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-launcher-"));
    try {
      const launcher = NodePath.join(directory, "launch's");
      NodeFS.writeFileSync(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      const launched = NodeChildProcess.spawnSync(launcher, ["--flag", "it's"], {
        encoding: "utf8",
      });
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(AGENT_OOM_SCORE_ADJ);
      expect(launchedArgs).toEqual(["a b", "$HOME", "--flag", "it's"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("withPathPrefix", () => {
  it("puts the directory first on PATH and passes the arguments through", () => {
    const launch = withPathPrefix(
      { command: "/bin/sh", args: ["-c", 'printf "%s\\n" "$PATH" "$@"', "agent", "a b", "$HOME"] },
      "/shim dir",
    );
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(child.stdout.trimEnd().split("\n")).toEqual(["/shim dir:/usr/bin:/bin", "a b", "$HOME"]);
  });

  it("leaves the launch alone without a directory", () => {
    const launch = { command: "codex", args: ["app-server"] };
    expect(withPathPrefix(launch, undefined)).toBe(launch);
  });
});
