import {
  NEW_THREAD_PRESET_COMMAND_PATTERN,
  type KeybindingCommand,
  type NewThreadPreset,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { nextProjectScriptId } from "./projectScripts";

const isNewThreadPresetCommand = Schema.is(NEW_THREAD_PRESET_COMMAND_PATTERN);

export function commandForNewThreadPreset(presetId: string): KeybindingCommand {
  return `preset.${presetId}.new`;
}

export function newThreadPresetIdFromCommand(command: string): string | null {
  if (!isNewThreadPresetCommand(command)) return null;
  const [prefix, , suffix] = NEW_THREAD_PRESET_COMMAND_PATTERN.parts;
  return command.slice(prefix.literal.length, -suffix.literal.length);
}

// Distributes over the project modes; a plain Omit keeps only their shared keys.
type WithoutId<Preset> = Preset extends unknown ? Omit<Preset, "id"> : never;

/**
 * Saving under an existing name updates that preset in place, so its id and
 * any keybinding on `preset.{id}.new` survive re-saving from a new draft.
 */
export function saveNewThreadPreset(
  presets: ReadonlyArray<NewThreadPreset>,
  input: WithoutId<NewThreadPreset>,
): ReadonlyArray<NewThreadPreset> {
  const name = input.name.trim();
  const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return presets.map((preset) =>
      preset.id === existing.id ? { ...input, id: existing.id, name } : preset,
    );
  }
  const id = nextProjectScriptId(
    name,
    presets.map((preset) => preset.id),
  );
  return [...presets, { ...input, id, name }];
}

/** `pinnedLabel` names a pinned preset's project and machine, or a no-project preset's machine. */
export function describeNewThreadPreset(
  preset: NewThreadPreset,
  pinnedLabel: string | null,
): string {
  const optionValues = (preset.modelSelection.options ?? []).flatMap((option) =>
    typeof option.value === "string" ? [option.value] : [],
  );
  if (preset.project === "none") {
    const where =
      preset.environmentId && pinnedLabel ? `no project on ${pinnedLabel}` : "no project";
    return [preset.modelSelection.model, ...optionValues, where].join(" · ");
  }
  const project =
    preset.project === "current" ? "current project" : (pinnedLabel ?? "missing project");
  const workspace =
    preset.envMode === "local"
      ? "current checkout"
      : preset.envMode === "worktree"
        ? `new worktree${preset.startFromOrigin ? " from origin" : ""}`
        : "default workspace";
  return [preset.modelSelection.model, ...optionValues, `${project}, ${workspace}`].join(" · ");
}
