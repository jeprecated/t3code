const SAVE_DRAFT_AS_PRESET_EVENT = "t3:save-draft-as-new-thread-preset";

export function requestSaveDraftAsNewThreadPreset(): void {
  window.dispatchEvent(new Event(SAVE_DRAFT_AS_PRESET_EVENT));
}

export function subscribeSaveDraftAsNewThreadPreset(listener: () => void): () => void {
  window.addEventListener(SAVE_DRAFT_AS_PRESET_EVENT, listener);
  return () => window.removeEventListener(SAVE_DRAFT_AS_PRESET_EVENT, listener);
}
