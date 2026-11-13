import { useAtomValue } from "@effect/atom-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { useYouQueue } from "../../youQueue";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** Threads | You (n), where n is what waits on the user now. */
export function SidebarModeToggle({ count }: { readonly count: number }) {
  const mode = useUiStateStore((state) => state.sidebarMode);
  const setMode = useUiStateStore((state) => state.setSidebarMode);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "sidebar.toggleYouQueue");
  return (
    <ToggleGroup
      aria-label="Sidebar view"
      className="w-full *:flex-1"
      value={[mode]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "threads" || value === "you") setMode(value);
      }}
    >
      <Toggle value="threads">Threads</Toggle>
      <Toggle
        value="you"
        aria-label={`You: ${count} waiting on you`}
        title={shortcut ? `Everything waiting on you (${shortcut})` : "Everything waiting on you"}
      >
        You
        {count > 0 ? (
          <Badge variant="warning" size="sm">
            {count}
          </Badge>
        ) : null}
      </Toggle>
    </ToggleGroup>
  );
}

/** The toggle for Threads mode, which does not otherwise derive the queue. */
export function ThreadsModeToggle() {
  return <SidebarModeToggle count={useYouQueue().now.length} />;
}
