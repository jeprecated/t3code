import type { ThreadCategoryView } from "@t3tools/contracts";
import { threadCategoryLabel } from "@t3tools/shared/threadCategories";
import { useId, useState } from "react";
import { create } from "zustand";

import { useUpdatePrimarySettings } from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import {
  readThreadCategoryViews,
  selectSidebarCategoryScope,
  useThreadCategories,
  useThreadCategoryViews,
} from "../threadCategories";
import { useUiStateStore } from "../uiStateStore";
import { CategorySwatch } from "./CategorySwatch";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
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

/** Null edits nothing; an empty `viewId` creates a view. */
const useRequest = create<{ viewId: string | null }>(() => ({ viewId: null }));

/** Opens the view editor for `viewId`, or for a new view seeded from the sidebar's current filter. */
export function openSidebarViewEditor(viewId?: string): void {
  useRequest.setState({ viewId: viewId ?? "" });
}

/** Edits the view the sidebar shows, or starts a new one when it shows something else. */
export function editCurrentSidebarView(): void {
  const scope = useUiStateStore.getState().sidebarCategoryScope;
  openSidebarViewEditor(scope?.type === "view" ? scope.viewId : undefined);
}

function close() {
  useRequest.setState({ viewId: null });
}

function seedCategoryIds(): readonly string[] {
  const scope = useUiStateStore.getState().sidebarCategoryScope;
  if (scope?.type === "category") return [scope.categoryId];
  if (scope?.type === "view") {
    return readThreadCategoryViews().find((view) => view.id === scope.viewId)?.categoryIds ?? [];
  }
  return [];
}

export function SidebarViewDialogHost() {
  const viewId = useRequest((state) => state.viewId);
  const views = useThreadCategoryViews();
  if (viewId === null) return null;
  const view = views.find((candidate) => candidate.id === viewId) ?? null;
  // A view deleted on another device closes its editor rather than turning it into "New view".
  if (viewId !== "" && view === null) return null;
  // Keyed so reopening for another view starts from that view's values.
  return <SidebarViewDialog key={viewId} view={view} />;
}

function SidebarViewDialog({ view }: { view: ThreadCategoryView | null }) {
  const id = useId();
  const categories = useThreadCategories();
  const updateSettings = useUpdatePrimarySettings();
  const [name, setName] = useState(view?.name ?? "");
  const [categoryIds, setCategoryIds] = useState<readonly string[]>(
    () => view?.categoryIds ?? seedCategoryIds(),
  );
  const trimmed = name.trim();
  // Keep category order so the view reads like the category list; deleted categories drop out.
  const ordered = categories
    .map((category) => category.id)
    .filter((categoryId) => categoryIds.includes(categoryId));
  const canSave = trimmed.length > 0 && ordered.length > 0;

  // Writes start from the latest list the servers reported, not the one this dialog opened with.
  const writeViews = (update: (current: readonly ThreadCategoryView[]) => ThreadCategoryView[]) =>
    updateSettings({ threadCategoryViews: update(readThreadCategoryViews()) });

  const save = () => {
    if (!canSave) return;
    if (view) {
      writeViews((current) =>
        current.map((candidate) =>
          candidate.id === view.id
            ? { ...candidate, name: trimmed, categoryIds: ordered }
            : candidate,
        ),
      );
    } else {
      const created = { id: randomUUID(), name: trimmed, categoryIds: ordered };
      writeViews((current) => [...current, created]);
      selectSidebarCategoryScope({ type: "view", viewId: created.id });
    }
    close();
  };

  const remove = () => {
    if (!view) return;
    writeViews((current) => current.filter((candidate) => candidate.id !== view.id));
    const scope = useUiStateStore.getState().sidebarCategoryScope;
    if (scope?.type === "view" && scope.viewId === view.id) selectSidebarCategoryScope(null);
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
            <DialogTitle>{view ? "Edit view" : "New view"}</DialogTitle>
            <DialogDescription>
              Shows threads in any of the chosen categories. The sidebar's next-category shortcut
              cycles through your views.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                value={name}
                placeholder="Client"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset className="mt-4 flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium">Categories</legend>
              {categories.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create categories in Settings › General › Sidebar first.
                </p>
              ) : (
                categories.map((category) => (
                  <Label key={category.id}>
                    <Checkbox
                      checked={categoryIds.includes(category.id)}
                      onCheckedChange={(checked) =>
                        setCategoryIds((current) =>
                          checked
                            ? [...current, category.id]
                            : current.filter((categoryId) => categoryId !== category.id),
                        )
                      }
                    />
                    <CategorySwatch color={category.color} className="size-3" />
                    {threadCategoryLabel(category)}
                  </Label>
                ))
              )}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            {view ? (
              <Button type="button" variant="destructive-outline" onClick={remove}>
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
