import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { NewThreadPresetMachineSelect } from "./NewThreadPresetMachineSelect";
import { Label } from "./ui/label";
import { Radio, RadioGroup } from "./ui/radio-group";

export interface NewThreadPresetSaveChoice {
  readonly name: string;
  readonly pinProject: boolean;
  /** Undefined starts on whichever machine is current; ignored for a pinned project. */
  readonly environmentId: EnvironmentId | undefined;
}

interface Request {
  readonly existingNames: ReadonlyArray<string>;
  /** Null for a draft without a project. */
  readonly projectLabel: string | null;
  readonly environmentId: EnvironmentId;
  readonly resolve: (choice: NewThreadPresetSaveChoice | null) => void;
}
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestNewThreadPresetSave(
  input: Omit<Request, "resolve">,
): Promise<NewThreadPresetSaveChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(choice: NewThreadPresetSaveChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function NewThreadPresetNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? (
    <NewThreadPresetNameDialog
      existingNames={request.existingNames}
      projectLabel={request.projectLabel}
      environmentId={request.environmentId}
    />
  ) : null;
}

function NewThreadPresetNameDialog({
  existingNames,
  projectLabel,
  environmentId,
}: {
  existingNames: ReadonlyArray<string>;
  projectLabel: string | null;
  environmentId: EnvironmentId;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [pinProject, setPinProject] = useState(true);
  // A draft without a project keeps its machine unless the user widens it.
  const [machine, setMachine] = useState<EnvironmentId | undefined>(
    projectLabel === null ? environmentId : undefined,
  );
  const choosesMachine = projectLabel === null || !pinProject;
  const trimmed = name.trim();
  const replaces = existingNames.some(
    (existing) => existing.toLowerCase() === trimmed.toLowerCase(),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish({ name: trimmed, pinProject, environmentId: machine });
          }}
        >
          <DialogHeader>
            <DialogTitle>Save as new-thread preset</DialogTitle>
            <DialogDescription>
              Saves this draft's model, effort, workspace, project, and machine.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                value={name}
                placeholder="Quick"
                onChange={(event) => setName(event.target.value)}
              />
              {replaces ? (
                <p className="text-xs text-muted-foreground">
                  Replaces the preset with this name and keeps its shortcut.
                </p>
              ) : null}
            </div>
            {projectLabel !== null ? (
              <div className="mt-4 flex flex-col gap-1.5">
                <span id={`${id}-project`} className="text-sm font-medium">
                  Project
                </span>
                <RadioGroup
                  aria-labelledby={`${id}-project`}
                  value={pinProject ? "pinned" : "current"}
                  onValueChange={(value) => setPinProject(value === "pinned")}
                >
                  <Label>
                    <Radio value="pinned" />
                    {projectLabel}
                  </Label>
                  <Label>
                    <Radio value="current" />
                    Whichever project I'm in
                  </Label>
                </RadioGroup>
              </div>
            ) : null}
            {choosesMachine ? (
              <div className="mt-4 flex flex-col gap-1.5">
                <Label htmlFor={`${id}-machine`}>Machine</Label>
                <NewThreadPresetMachineSelect
                  id={`${id}-machine`}
                  label="Machine"
                  value={machine}
                  onValueChange={setMachine}
                />
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {replaces ? "Replace" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
