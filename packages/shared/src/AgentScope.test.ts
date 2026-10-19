// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand, withPathPrefix } from "./AgentScope.ts";
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
