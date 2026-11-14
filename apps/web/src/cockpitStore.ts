import { create } from "zustand";

export const useCockpitStore = create<{
  readonly open: boolean;
  /** Focus goes back here on close, unless the cockpit navigated away. */
  readonly returnFocus: Element | null;
  readonly helpOpen: boolean;
  /** The list's selection, kept for reopening in this session. */
  readonly lastSelectedKey: string | null;
}>(() => ({ open: false, returnFocus: null, helpOpen: false, lastSelectedKey: null }));

export function setCockpitOpen(open: boolean) {
  if (open === useCockpitStore.getState().open) return;
  useCockpitStore.setState(
    open ? { open, returnFocus: document.activeElement, helpOpen: false } : { open },
  );
}

export const isCockpitOpen = () => useCockpitStore.getState().open;
