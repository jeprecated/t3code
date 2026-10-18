import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  CommandOutputPanel,
  useBackgroundTaskOutput,
  useCommandOutputStreaming,
} from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";

/** Which background work this environment can show live output for. */
export function useBackgroundCommandOutputSupport(
  environmentId: EnvironmentId,
): (item: PendingBackgroundWorkItem) => boolean {
  const rows = useCommandOutputStreaming(environmentId);
  const tasks = useBackgroundTaskOutput(environmentId);
  return (item) => item.kind === "command" && (item.itemId === undefined ? tasks : rows);
}

/**
 * Opens a running background command's output. The popup mounts only while open,
 * so its output is streamed only while someone reads it.
 */
export function BackgroundCommandOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly item: PendingBackgroundWorkItem;
  readonly children: ReactNode;
}) {
  const { item } = props;
  return (
    <Popover>
      <PopoverTrigger
        render={<InlineButton tone="muted" />}
        className="max-w-full"
        aria-label={`Show output of ${item.label}`}
      >
        {props.children}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="lg">
        <div className="space-y-1.5 font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text">
          {item.command ? <ShellCommandBlock command={item.command} /> : null}
          {item.itemId === undefined ? (
            <CommandOutputPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
              taskId={item.taskId}
            />
          ) : (
            <CommandOutputPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
              itemId={item.itemId}
            />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
