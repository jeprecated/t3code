import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  stepSidebarCategoryScope,
  type SidebarCategoryScope,
} from "@t3tools/client-runtime/state/sidebar-categories";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  compileThreadCategoryRules,
  resolveThreadCategoryIds,
  threadCategoryLabel,
  type ThreadCategorySubject,
} from "@t3tools/shared/threadCategories";
import type {
  EnvironmentId,
  OrchestrationV2ThreadCategories,
  OrchestrationV2ThreadCategoryChange,
  ScopedThreadRef,
  ServerConfig,
  ServerSettings,
  ThreadCategory,
  ThreadCategoryView,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { toastManager } from "./components/ui/toast";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readProject, readThreadShell } from "./state/entities";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { environmentServerConfigsAtom } from "./state/server";
import { threadEnvironment } from "./state/threads";
import { useOrchestrationCommand } from "./state/use-orchestration-command";
import { useUiStateStore } from "./uiStateStore";

export function environmentSupportsThreadCategories(
  config: Pick<ServerConfig, "environment"> | undefined,
): boolean {
  return config?.environment.capabilities.threadCategories === true;
}

/**
 * Edits write the same list to every connected environment, so the primary
 * environment's copy stands for all of them; the hosted app, which has no
 * primary, reads the first environment that supports categories.
 */
function selectCategorySettings(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  primaryEnvironmentId: EnvironmentId | null,
): ServerSettings | null {
  const primary = primaryEnvironmentId === null ? undefined : configs.get(primaryEnvironmentId);
  if (environmentSupportsThreadCategories(primary)) return primary!.settings;
  for (const config of configs.values()) {
    if (environmentSupportsThreadCategories(config)) return config.settings;
  }
  return null;
}

const categorySettingsAtom = Atom.make((get) =>
  selectCategorySettings(get(environmentServerConfigsAtom), get(primaryEnvironmentIdAtom)),
).pipe(Atom.withLabel("web:thread-category-settings"));

const NO_CATEGORIES: readonly ThreadCategory[] = [];
const NO_VIEWS: readonly ThreadCategoryView[] = [];

const threadCategoriesAtom = Atom.make(
  (get) => get(categorySettingsAtom)?.threadCategories ?? NO_CATEGORIES,
).pipe(Atom.withLabel("web:thread-categories"));

const threadCategoryViewsAtom = Atom.make(
  (get) => get(categorySettingsAtom)?.threadCategoryViews ?? NO_VIEWS,
).pipe(Atom.withLabel("web:thread-category-views"));

/** False until some connected environment can store categories. */
const threadCategoriesEditableAtom = Atom.make((get) => get(categorySettingsAtom) !== null).pipe(
  Atom.withLabel("web:thread-categories-editable"),
);

export function useThreadCategoriesEditable(): boolean {
  return useAtomValue(threadCategoriesEditableAtom);
}

export function useThreadCategoryViews(): readonly ThreadCategoryView[] {
  return useAtomValue(threadCategoryViewsAtom);
}

export function readThreadCategoryViews(): readonly ThreadCategoryView[] {
  return appAtomRegistry.get(threadCategoryViewsAtom);
}

export function useThreadCategories(): readonly ThreadCategory[] {
  return useAtomValue(threadCategoriesAtom);
}

export function readThreadCategories(): readonly ThreadCategory[] {
  return appAtomRegistry.get(threadCategoriesAtom);
}

export interface ThreadCategoryMembership {
  readonly categories: readonly ThreadCategory[];
  readonly ruleCategoryIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly state: OrchestrationV2ThreadCategories | null;
}

export function resolveThreadCategoryMembership(input: {
  readonly categories: readonly ThreadCategory[];
  readonly subject: ThreadCategorySubject;
  readonly state: OrchestrationV2ThreadCategories | null | undefined;
}): ThreadCategoryMembership {
  const ruleCategoryIds = compileThreadCategoryRules(input.categories)(input.subject);
  const state = input.state ?? null;
  return {
    categories: input.categories,
    ruleCategoryIds,
    categoryIds: resolveThreadCategoryIds(input.categories, ruleCategoryIds, state),
    state,
  };
}

/** Null when the thread is unknown or its environment cannot store categories. */
export function readThreadCategoryMembership(
  threadRef: ScopedThreadRef,
): ThreadCategoryMembership | null {
  const thread = readThreadShell(threadRef);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const categories = appAtomRegistry.get(threadCategoriesAtom);
  if (
    !thread ||
    categories.length === 0 ||
    !environmentSupportsThreadCategories(configs.get(threadRef.environmentId))
  ) {
    return null;
  }
  return resolveThreadCategoryMembership({
    categories,
    subject: {
      environmentId: thread.environmentId,
      providerInstanceId: thread.providerInstanceId,
      branch: thread.branch,
      project: readProject(scopeProjectRef(thread.environmentId, thread.projectId)),
    },
    state: thread.categories,
  });
}

export function useUpdateThreadCategories() {
  const update = useOrchestrationCommand(threadEnvironment.updateCategories, {
    reportFailure: false,
  });
  return async (
    threadRef: ScopedThreadRef,
    input: {
      readonly changes?: readonly OrchestrationV2ThreadCategoryChange[];
      readonly resolveSuggestion?: boolean;
    },
  ): Promise<void> => {
    const result = await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...input },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change thread categories",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
}

function sidebarCategoryScopeLabel(
  scope: SidebarCategoryScope | null,
  categories: readonly ThreadCategory[],
  views: readonly ThreadCategoryView[],
): string {
  if (scope === null) return "All projects";
  switch (scope.type) {
    case "uncategorized":
      return "Uncategorized";
    case "view":
      return views.find((view) => view.id === scope.viewId)?.name ?? "All projects";
    case "category": {
      const category = categories.find((candidate) => candidate.id === scope.categoryId);
      return category ? threadCategoryLabel(category) : "All projects";
    }
  }
}

/** Choosing a category clears the project scope; choosing everything clears both. */
export function selectSidebarCategoryScope(scope: SidebarCategoryScope | null): void {
  const store = useUiStateStore.getState();
  store.setSidebarCategoryScope(scope);
  if (scope === null) store.setSidebarProjectScopeKeys([]);
}

export function stepSidebarCategory(direction: 1 | -1): void {
  const categories = readThreadCategories();
  const views = readThreadCategoryViews();
  if (categories.length === 0) {
    toastManager.add({
      id: "sidebar-category-step",
      title: "No thread categories",
      description: "Create them in Settings › General › Sidebar.",
      timeout: 2500,
    });
    return;
  }
  const scope = stepSidebarCategoryScope({
    scope: useUiStateStore.getState().sidebarCategoryScope,
    categories,
    views,
    direction,
  });
  selectSidebarCategoryScope(scope);
  toastManager.add({
    id: "sidebar-category-step",
    title: `Sidebar: ${sidebarCategoryScopeLabel(scope, categories, views)}`,
    timeout: 1500,
  });
}
