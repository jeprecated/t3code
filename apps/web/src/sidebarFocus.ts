import {
  stepSidebarFocusScope,
  type SidebarFocusScope,
} from "@t3tools/client-runtime/state/sidebar-focus-groups";
import type { SidebarFocusGroup } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { useUiStateStore } from "./uiStateStore";

export function sidebarFocusGroupLabel(group: Pick<SidebarFocusGroup, "name">): string {
  return group.name.trim() || "Untitled group";
}

export function sidebarFocusScopeLabel(
  scope: SidebarFocusScope | null,
  groups: readonly SidebarFocusGroup[],
): string {
  if (scope === null) return "All projects";
  if (scope.type === "ungrouped") return "Everything else";
  const group = groups.find((candidate) => candidate.id === scope.groupId);
  return group ? sidebarFocusGroupLabel(group) : "All projects";
}

/** Choosing a focus clears any single-project scope; choosing everything clears both. */
export function selectSidebarFocusScope(scope: SidebarFocusScope | null): void {
  const store = useUiStateStore.getState();
  store.setSidebarFocusScope(scope);
  if (scope === null) store.setSidebarProjectScopeKey(null);
}

export function stepSidebarFocus(direction: 1 | -1, groups: readonly SidebarFocusGroup[]): void {
  if (groups.length === 0) {
    toastManager.add({
      id: "sidebar-focus-step",
      title: "No sidebar focus groups",
      description: "Create them in Settings › General.",
      timeout: 2500,
    });
    return;
  }
  const scope = stepSidebarFocusScope({
    scope: useUiStateStore.getState().sidebarFocusScope,
    groups,
    direction,
  });
  selectSidebarFocusScope(scope);
  toastManager.add({
    id: "sidebar-focus-step",
    title: `Sidebar: ${sidebarFocusScopeLabel(scope, groups)}`,
    timeout: 1500,
  });
}
