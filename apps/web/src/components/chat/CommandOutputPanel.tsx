import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { T, Var } from "gt-react";
import { useLayoutEffect, useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

const FOLLOW_SLACK_PX = 8;

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/** True when the environment streams the output of background commands its providers list. */
export function useBackgroundTaskOutput(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.backgroundTaskOutput === true
  );
}

/**
 * A command row's output, or a background command's by `taskId`: streams while the command
 * runs, then shows its final output. Mount only when useCommandOutputStreaming
 * (useBackgroundTaskOutput for a task) holds or a `source` serves the output.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(
  props: {
    readonly onInitialOutputReady?: (() => void) | undefined;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } & (
    | {
        readonly itemId: TurnItemId;
        readonly source?: TurnItemSource["commandOutput"] | undefined;
      }
    | { readonly taskId: string }
  ),
) {
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    "itemId" in props
      ? props.source
        ? props.source({ threadId: props.threadId, itemId: props.itemId })
        : orchestrationEnvironment.v2.commandOutput({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, itemId: props.itemId },
          })
      : orchestrationEnvironment.v2.backgroundTaskOutput({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, taskId: props.taskId },
        }),
  );
  useInitialOutputReady(data === null && !error, props.onInitialOutputReady);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the output scroller's scrollTop to the bottom after each commit while the user follows
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) {
    if (error) {
      return (
        <div className="text-destructive">
          <T>
            Couldn&apos;t load output: <Var>{error}</Var>
          </T>
        </div>
      );
    }
    if (data === null) {
      return (
        <div className="text-muted-foreground italic">
          <T>Loading output…</T>
        </div>
      );
    }
    return data.running ? null : (
      <div className="text-muted-foreground italic">
        <T>No output.</T>
      </div>
    );
  }
  // Parse after all hooks to preserve the text/theme compiler cache.
  const spans = terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme]);
  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
      }}
      className="max-h-80 overflow-auto text-muted-foreground"
    >
      {data?.output.truncated ? (
        <div className="italic">
          <T>Earlier output not shown</T>
        </div>
      ) : null}
      {spans.map((span, index) =>
        span.style === null ? (
          span.text
        ) : (
          // Spans never reorder and are rebuilt on each update.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ),
      )}
    </div>
  );
}
