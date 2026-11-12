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
import { Toggle, ToggleGroup } from "./ui/toggle-group";

type ViewFilter = Pick<ThreadCategoryView, "categoryIds" | "excludedCategoryIds">;

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

function seedFilter(): ViewFilter {
  const scope = useUiStateStore.getState().sidebarCategoryScope;
  if (scope?.type === "category")
    return { categoryIds: [scope.categoryId], excludedCategoryIds: [] };
  if (scope?.type === "view") {
    const view = readThreadCategoryViews().find((candidate) => candidate.id === scope.viewId);
    if (view) return view;
  }
  return { categoryIds: [], excludedCategoryIds: [] };
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
  const [filter, setFilter] = useState<ViewFilter>(() => view ?? seedFilter());
  const trimmed = name.trim();
  // Keep category order so the view reads like the category list; deleted categories drop out.
  const inOrder = (ids: readonly string[]) =>
    categories.map((category) => category.id).filter((categoryId) => ids.includes(categoryId));
  const ordered = {
    categoryIds: inOrder(filter.categoryIds),
    excludedCategoryIds: inOrder(filter.excludedCategoryIds),
  };
  const canSave =
    trimmed.length > 0 && ordered.categoryIds.length + ordered.excludedCategoryIds.length > 0;
  const setChoice = (categoryId: string, choice: "include" | "exclude" | null) =>
    setFilter((current) => ({
      categoryIds: [
        ...current.categoryIds.filter((id) => id !== categoryId),
        ...(choice === "include" ? [categoryId] : []),
      ],
      excludedCategoryIds: [
        ...current.excludedCategoryIds.filter((id) => id !== categoryId),
        ...(choice === "exclude" ? [categoryId] : []),
      ],
    }));

  // Writes start from the latest list the servers reported, not the one this dialog opened with.
  const writeViews = (update: (current: readonly ThreadCategoryView[]) => ThreadCategoryView[]) =>
    updateSettings({ threadCategoryViews: update(readThreadCategoryViews()) });

  const save = () => {
    if (!canSave) return;
    if (view) {
      writeViews((current) =>
        current.map((candidate) =>
          candidate.id === view.id ? { ...candidate, name: trimmed, ...ordered } : candidate,
        ),
      );
    } else {
      const created = { id: randomUUID(), name: trimmed, ...ordered };
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
              Shows threads in any included category and no excluded one. Exclude without including
              to show everything else. The sidebar's next-category shortcut cycles through your
              views.
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
            <fieldset className="mt-4 flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">Categories</legend>
              {categories.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create categories in Settings › General › Sidebar first.
                </p>
              ) : (
                categories.map((category) => {
                  const label = threadCategoryLabel(category);
                  const choice = filter.categoryIds.includes(category.id)
                    ? "include"
                    : filter.excludedCategoryIds.includes(category.id)
                      ? "exclude"
                      : null;
                  return (
                    <div key={category.id} className="flex items-center gap-2 text-sm">
                      <CategorySwatch color={category.color} className="size-3" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <ToggleGroup
                        aria-label={label}
                        value={choice ? [choice] : []}
                        onValueChange={(next) => {
                          const value = next[0];
                          setChoice(
                            category.id,
                            value === "include" || value === "exclude" ? value : null,
                          );
                        }}
                      >
                        <Toggle value="include">Include</Toggle>
                        <Toggle value="exclude">Exclude</Toggle>
                      </ToggleGroup>
                    </div>
                  );
                })
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
