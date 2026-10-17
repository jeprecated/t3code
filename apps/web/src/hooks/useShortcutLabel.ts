import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

export function useShortcutLabel(command: KeybindingCommand): string | null {
  return shortcutLabelForCommand(useAtomValue(primaryServerKeybindingsAtom), command);
}
