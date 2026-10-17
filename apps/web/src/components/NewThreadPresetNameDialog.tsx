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
import { Label } from "./ui/label";

type Request = {
  readonly existingNames: ReadonlyArray<string>;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestNewThreadPresetName(
  existingNames: ReadonlyArray<string>,
): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { existingNames, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function NewThreadPresetNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <NewThreadPresetNameDialog existingNames={request.existingNames} /> : null;
}

function NewThreadPresetNameDialog({ existingNames }: { existingNames: ReadonlyArray<string> }) {
  const id = useId();
  const [name, setName] = useState("");
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
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Save as new-thread preset</DialogTitle>
            <DialogDescription>
              Saves this draft's model, effort, workspace, and whether it has a project.
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
