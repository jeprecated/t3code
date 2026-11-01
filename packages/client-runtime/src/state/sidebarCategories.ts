import type { ThreadCategory } from "@t3tools/contracts";

export type SidebarCategoryScope =
  | { readonly type: "category"; readonly categoryId: string }
  | { readonly type: "uncategorized" };

export function sidebarCategoryScopeIncludes(
  scope: SidebarCategoryScope,
  categoryIds: readonly string[],
): boolean {
  return scope.type === "uncategorized"
    ? categoryIds.length === 0
    : categoryIds.includes(scope.categoryId);
}

/** Drops a scope whose category was deleted, so the sidebar falls back to everything. */
export function resolveSidebarCategoryScope(
  scope: SidebarCategoryScope | null,
  categories: readonly ThreadCategory[],
): SidebarCategoryScope | null {
  if (scope === null || categories.length === 0) return null;
  if (scope.type === "uncategorized") return scope;
  return categories.some((category) => category.id === scope.categoryId) ? scope : null;
}

/** Cycles everything → each category in order → uncategorized threads → everything. */
export function stepSidebarCategoryScope(input: {
  readonly scope: SidebarCategoryScope | null;
  readonly categories: readonly ThreadCategory[];
  readonly direction: 1 | -1;
}): SidebarCategoryScope | null {
  const steps: Array<SidebarCategoryScope | null> = [
    null,
    ...input.categories.map((category) => ({
      type: "category" as const,
      categoryId: category.id,
    })),
  ];
  if (input.categories.length > 0) steps.push({ type: "uncategorized" });
  const scope = resolveSidebarCategoryScope(input.scope, input.categories);
  const index = steps.findIndex((step) =>
    step === null || scope === null
      ? step === scope
      : step.type === "uncategorized"
        ? scope.type === "uncategorized"
        : scope.type === "category" && scope.categoryId === step.categoryId,
  );
  return steps[(index + input.direction + steps.length) % steps.length] ?? null;
}
