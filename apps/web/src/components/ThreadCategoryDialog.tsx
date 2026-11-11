import type { ThreadCategory } from "@t3tools/contracts";
import { useId, useState } from "react";
import { create } from "zustand";

import { useUpdatePrimarySettings } from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import { PROJECT_ICON_COLORS } from "../projectIconColors";
import { readThreadCategories, useThreadCategoriesEditable } from "../threadCategories";
import { CategorySwatch } from "./CategorySwatch";
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
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";

const useRequest = create<{ open: boolean }>(() => ({ open: false }));

export function openNewThreadCategoryDialog(): void {
  useRequest.setState({ open: true });
}

function close() {
  useRequest.setState({ open: false });
}

function nextColor(categories: readonly ThreadCategory[]): ThreadCategory["color"] {
  const used = new Set(categories.map((category) => category.color));
  const palette = PROJECT_ICON_COLORS.filter((color) => color.value !== "gray");
  return (palette.find((color) => !used.has(color.value)) ?? palette[0]!).value;
}

export function ThreadCategoryDialogHost() {
  const open = useRequest((state) => state.open);
  return open ? <ThreadCategoryDialog /> : null;
}

function ThreadCategoryDialog() {
  const id = useId();
  const editable = useThreadCategoriesEditable();
  const updateSettings = useUpdatePrimarySettings();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(() => nextColor(readThreadCategories()));
  const trimmed = name.trim();

  const save = () => {
    if (trimmed.length === 0 || !editable) return;
    // Starts from the latest list the servers reported, and writes it to every connected environment.
    updateSettings({
      threadCategories: [
        ...readThreadCategories(),
        { id: randomUUID(), name: trimmed, description: description.trim(), color, rules: [] },
      ],
    });
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
            <DialogDescription>
              Tag threads from their Categories menu. To file threads automatically, add rules in
              Settings › General › Sidebar.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <div className="flex items-center gap-2">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button type="button" size="icon" variant="outline" aria-label="Color" />
                    }
                  >
                    <CategorySwatch color={color} className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={color}
                      onValueChange={(value: ThreadCategory["color"]) => setColor(value)}
                    >
                      {PROJECT_ICON_COLORS.map((option) => (
                        <MenuRadioItem key={option.value} value={option.value}>
                          <CategorySwatch color={option.value} className="size-3" />
                          {option.label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <Input
                  id={`${id}-name`}
                  autoFocus
                  value={name}
                  placeholder="Brick"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor={`${id}-description`}>What belongs here</Label>
              <Input
                id={`${id}-description`}
                value={description}
                placeholder="LEGO client work"
                onChange={(event) => setDescription(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Helps new threads suggest this category.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || !editable}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
