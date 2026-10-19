import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  NEW_THREAD_PRESET_COMMAND_PATTERN,
  type EnvironmentId,
  type KeybindingCommand,
  type NewThreadPreset,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveLogicalProjectKey } from "./logicalProject";
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

/** A pinned project already fixes its machine. */
export function setNewThreadPresetMachine(
  preset: NewThreadPreset,
  environmentId: EnvironmentId | undefined,
): NewThreadPreset {
  if (preset.project === "pinned") return preset;
  const { environmentId: _, ...unpinned } = preset;
  return environmentId ? { ...unpinned, environmentId } : unpinned;
}

/** `pinnedLabel` names a pinned preset's project and machine, or another preset's machine. */
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
    preset.project === "pinned"
      ? (pinnedLabel ?? "missing project")
      : preset.environmentId && pinnedLabel
        ? `current project on ${pinnedLabel}`
        : "current project";
  const workspace =
    preset.envMode === "local"
      ? "current checkout"
      : preset.envMode === "worktree"
        ? `new worktree${preset.startFromOrigin ? " from origin" : ""}`
        : "default workspace";
  return [preset.modelSelection.model, ...optionValues, `${project}, ${workspace}`].join(" · ");
}

type PresetProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

export type NewThreadPresetStart =
  | { readonly kind: "project"; readonly projectRef: ScopedProjectRef }
  /** A null machine lets the caller pick the only one that can start without a project. */
  | { readonly kind: "scratch"; readonly environmentId: EnvironmentId | null }
  | { readonly kind: "machine-unavailable"; readonly environmentId: EnvironmentId }
  | { readonly kind: "project-unavailable" };

/**
 * Where a preset's new thread starts. A machine pin never falls back to another
 * machine: a current project elsewhere is swapped for the same repository on the
 * pinned machine, or for no project there.
 */
export function resolveNewThreadPresetStart(input: {
  readonly preset: NewThreadPreset;
  readonly currentProjectRef: ScopedProjectRef | null;
  readonly currentProject: PresetProject | null;
  readonly currentProjectIsScratch: boolean;
  readonly currentEnvironmentId: EnvironmentId | null;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly projects: ReadonlyArray<PresetProject>;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
}): NewThreadPresetStart | null {
  const { preset } = input;
  const pinned = preset.environmentId;
  if (pinned !== undefined && !input.isConnected(pinned)) {
    return { kind: "machine-unavailable", environmentId: pinned };
  }
  if (preset.project === "pinned") {
    const projectRef = { environmentId: preset.environmentId, projectId: preset.projectId };
    return input.projects.some(
      (project) =>
        project.environmentId === projectRef.environmentId && project.id === projectRef.projectId,
    )
      ? { kind: "project", projectRef }
      : { kind: "project-unavailable" };
  }
  if (preset.project === "none") {
    return { kind: "scratch", environmentId: pinned ?? input.currentEnvironmentId };
  }
  if (pinned === undefined) {
    // From a thread without a project, a project preset falls back to the
    // first sidebar project instead of starting another scratch draft.
    const projectRef = input.currentProjectIsScratch
      ? input.defaultProjectRef
      : input.currentProjectRef;
    return projectRef ? { kind: "project", projectRef } : null;
  }
  if (input.currentProjectRef?.environmentId === pinned && !input.currentProjectIsScratch) {
    return { kind: "project", projectRef: input.currentProjectRef };
  }
  const match =
    input.currentProject && !input.currentProjectIsScratch
      ? findSameRepositoryProject(
          input.currentProject,
          input.projects.filter((project) => project.environmentId === pinned),
        )
      : undefined;
  return match
    ? { kind: "project", projectRef: { environmentId: pinned, projectId: match.id } }
    : { kind: "scratch", environmentId: pinned };
}

// Keys without a repository identity include the machine, so they never match across machines.
function findSameRepositoryProject(
  project: PresetProject,
  candidates: ReadonlyArray<PresetProject>,
): PresetProject | undefined {
  for (const groupingMode of ["repository_path", "repository"] as const) {
    const key = deriveLogicalProjectKey(project, { groupingMode });
    const match = candidates.find(
      (candidate) => deriveLogicalProjectKey(candidate, { groupingMode }) === key,
    );
    if (match) return match;
  }
  return undefined;
}
