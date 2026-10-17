import type { KeybindingCommand } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useShortcutLabel } from "../hooks/useShortcutLabel";
import { Kbd } from "./ui/kbd";

export function ShortcutTooltipLabel({
  command,
  children,
}: {
  command: KeybindingCommand;
  children: ReactNode;
}) {
  const shortcut = useShortcutLabel(command);
  if (!shortcut) return children;
  return (
    <span className="inline-flex items-center gap-2">
      {children}
      <Kbd>{shortcut}</Kbd>
    </span>
  );
}
