import { useAtomValue } from "@effect/atom-react";
import { InboxIcon } from "lucide-react";

import { useCockpitQueue } from "../../cockpit";
import { setCockpitOpen } from "../../cockpitStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** The sidebar's way in: what waits on the user now, one click from the cockpit. */
export function CockpitButton() {
  const count = useCockpitQueue().now.length;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "cockpit.toggle");
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Cockpit: ${count} waiting on you`}
      title={shortcut ? `Everything waiting on you (${shortcut})` : "Everything waiting on you"}
      onClick={() => setCockpitOpen(true)}
    >
      <InboxIcon />
      Cockpit
      {count > 0 ? (
        <Badge variant="warning" size="sm">
          {count}
        </Badge>
      ) : null}
    </Button>
  );
}
