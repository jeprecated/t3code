import type { NewThreadPreset } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  commandForNewThreadPreset,
  describeNewThreadPreset,
  setNewThreadPresetMachine,
} from "../../newThreadPresets";
import { NewThreadPresetMachineSelect } from "../NewThreadPresetMachineSelect";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function NewThreadPresetsSettings() {
  const presets = usePrimarySettings((settings) => settings.newThreadPresets);
  const updateSettings = useUpdatePrimarySettings();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const pinnedLabel = (preset: NewThreadPreset): string | null => {
    if (preset.environmentId === undefined) return null;
    const machine = environments.find(
      (environment) => environment.environmentId === preset.environmentId,
    )?.label;
    if (preset.project !== "pinned") return machine ?? null;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === preset.environmentId && candidate.id === preset.projectId,
    );
    if (!project) return null;
    return machine ? `${project.title} on ${machine}` : project.title;
  };
  const save = (next: ReadonlyArray<NewThreadPreset>) =>
    updateSettings({ newThreadPresets: [...next] });

  return (
    <SettingsSection id="new-thread-presets" title="New thread presets">
      {presets.length === 0 ? (
        <SettingsRow
          serverScoped
          title="No presets yet"
          description="Set up a new thread's model, effort, project, and workspace, then run “Save draft as new-thread preset…” from the command palette."
        />
      ) : (
        presets.map((preset) => (
          <SettingsRow
            key={preset.id}
            serverScoped
            title={preset.name}
            description={
              <>
                {describeNewThreadPreset(preset, pinnedLabel(preset))}
                <br />
                <code>{commandForNewThreadPreset(preset.id)}</code>
              </>
            }
            control={
              <div className="flex items-center gap-1.5">
                {preset.project === "pinned" ? null : (
                  <NewThreadPresetMachineSelect
                    label={`Machine for preset ${preset.name}`}
                    value={preset.environmentId}
                    onValueChange={(environmentId) =>
                      save(
                        presets.map((candidate) =>
                          candidate.id === preset.id
                            ? setNewThreadPresetMachine(candidate, environmentId)
                            : candidate,
                        ),
                      )
                    }
                  />
                )}
                <PresetNameInput
                  preset={preset}
                  takenNames={presets
                    .filter((candidate) => candidate.id !== preset.id)
                    .map((candidate) => candidate.name.toLowerCase())}
                  onRename={(name) =>
                    save(
                      presets.map((candidate) =>
                        candidate.id === preset.id ? { ...candidate, name } : candidate,
                      ),
                    )
                  }
                />
                <Tooltip>
                  <TooltipTrigger
                    delay={200}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={() =>
                          save(presets.filter((candidate) => candidate.id !== preset.id))
                        }
                      />
                    }
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Delete preset</TooltipPopup>
                </Tooltip>
              </div>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function PresetNameInput({
  preset,
  takenNames,
  onRename,
}: {
  preset: NewThreadPreset;
  takenNames: ReadonlyArray<string>;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(preset.name);
  const commit = () => {
    const trimmed = name.trim();
    if (
      trimmed.length === 0 ||
      trimmed === preset.name ||
      takenNames.includes(trimmed.toLowerCase())
    ) {
      setName(preset.name);
      return;
    }
    onRename(trimmed);
  };
  return (
    <div className="w-40">
      <Input
        size="sm"
        aria-label={`Rename preset ${preset.name}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setName(preset.name);
        }}
      />
    </div>
  );
}
