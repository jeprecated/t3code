import type { NewThreadPreset } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commandForNewThreadPreset,
  newThreadPresetIdFromCommand,
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
});
