import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ScrollView } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ThreadCommandOutput,
  useBackgroundTaskOutput,
  useCommandOutputStreaming,
} from "./thread-command-output";

/** Which background work this environment can show live output for. */
export function useBackgroundCommandOutputSupport(
  environmentId: EnvironmentId,
): (item: PendingBackgroundWorkItem) => boolean {
  const rows = useCommandOutputStreaming(environmentId);
  const tasks = useBackgroundTaskOutput(environmentId);
  return (item) => item.kind === "command" && (item.itemId === undefined ? tasks : rows);
}

/** A running background command's output, streamed only while the sheet is open. */
export function BackgroundCommandOutputSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly item: PendingBackgroundWorkItem;
  readonly onClose: () => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const { item } = props;
  return (
    <Sheet title={item.label} onClose={props.onClose}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-4 pb-8">
        {item.command ? (
          <Text selectable className="font-mono text-xs leading-normal text-foreground">
            $ {item.command}
          </Text>
        ) : null}
        {item.itemId === undefined ? (
          <ThreadCommandOutput
            environmentId={props.environmentId}
            threadId={props.threadId}
            taskId={item.taskId}
            themeAppearance={themeAppearance}
          />
        ) : (
          <ThreadCommandOutput
            environmentId={props.environmentId}
            threadId={props.threadId}
            itemId={item.itemId}
            themeAppearance={themeAppearance}
          />
        )}
      </ScrollView>
    </Sheet>
  );
}
