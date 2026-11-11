import type { ThreadCategory, ThreadCategoryView } from "@t3tools/contracts";

export type SidebarCategoryScope =
  | { readonly type: "category"; readonly categoryId: string }
  | { readonly type: "view"; readonly viewId: string }
  | { readonly type: "uncategorized" };

export function sidebarCategoryScopeIncludes(
  scope: SidebarCategoryScope,
  categoryIds: readonly string[],
  views: readonly ThreadCategoryView[],
): boolean {
  switch (scope.type) {
    case "uncategorized":
      return categoryIds.length === 0;
    case "category":
      return categoryIds.includes(scope.categoryId);
    case "view": {
      const view = views.find((candidate) => candidate.id === scope.viewId);
      return view?.categoryIds.some((id) => categoryIds.includes(id)) ?? false;
    }
  }
}

export function sameSidebarCategoryScope(
  a: SidebarCategoryScope | null,
  b: SidebarCategoryScope | null,
): boolean {
  if (a === null || b === null) return a === b;
  switch (a.type) {
    case "uncategorized":
      return b.type === "uncategorized";
    case "category":
      return b.type === "category" && a.categoryId === b.categoryId;
    case "view":
      return b.type === "view" && a.viewId === b.viewId;
  }
}

/** Drops a scope whose category or view was deleted, so the sidebar falls back to everything. */
export function resolveSidebarCategoryScope(
  scope: SidebarCategoryScope | null,
  categories: readonly ThreadCategory[],
  views: readonly ThreadCategoryView[],
): SidebarCategoryScope | null {
  if (scope === null || categories.length === 0) return null;
  switch (scope.type) {
    case "uncategorized":
      return scope;
    case "category":
      return categories.some((category) => category.id === scope.categoryId) ? scope : null;
    case "view":
      return views.some((view) => view.id === scope.viewId) ? scope : null;
  }
}

/**
 * Cycles everything → each saved view → everything, passing over views whose
 * threads are all snoozed or settled. Without views it cycles everything →
 * each category in order → uncategorized threads → everything.
 */
export function stepSidebarCategoryScope(input: {
  readonly scope: SidebarCategoryScope | null;
  readonly categories: readonly ThreadCategory[];
  readonly views: readonly ThreadCategoryView[];
  readonly direction: 1 | -1;
  readonly viewIsIdle?: (view: ThreadCategoryView) => boolean;
}): SidebarCategoryScope | null {
  const steps: Array<SidebarCategoryScope | null> = [null];
  if (input.categories.length > 0 && input.views.length > 0) {
    for (const view of input.views) {
      // The view being left keeps its place so stepping continues from it.
      const current = input.scope?.type === "view" && input.scope.viewId === view.id;
      if (current || !input.viewIsIdle?.(view)) steps.push({ type: "view", viewId: view.id });
    }
  } else if (input.categories.length > 0) {
    for (const category of input.categories) {
      steps.push({ type: "category", categoryId: category.id });
    }
    steps.push({ type: "uncategorized" });
  }
  const scope = resolveSidebarCategoryScope(input.scope, input.categories, input.views);
  const index = steps.findIndex((step) => sameSidebarCategoryScope(step, scope));
  // A scope outside the cycle (a single category while views exist) steps from everything.
  const from = index === -1 ? 0 : index;
  return steps[(from + input.direction + steps.length) % steps.length] ?? null;
}
