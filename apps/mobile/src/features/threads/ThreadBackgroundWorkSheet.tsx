import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  backgroundWorkOutputSource,
  presentPendingBackgroundWork,
  type BackgroundWorkOutputSource,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SheetHeader } from "../../components/ui/SheetHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ThreadCommandOutput,
  useBackgroundTaskOutput,
  useCommandOutputStreaming,
} from "./thread-command-output";

const KIND_LABELS = {
  subagent: msg("Subagent"),
  command: msg("Command", { $context: "noun, a running shell command" }),
  monitor: msg("Monitor", { $context: "noun, a background watcher task" }),
  background_task: msg("Background task"),
} as const;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const target = route.params;
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  const thread = useAtomValue(environmentThreadShells.threadShellAtom(ref));
  const turnItems = useAtomValue(environmentThreadDetails.quietThreadAtom(ref))?.projection
    .turnItems;
  const streamsOutput = useCommandOutputStreaming(target.environmentId);
  const streamsTaskOutput = useBackgroundTaskOutput(target.environmentId);
  const tasks = thread?.pendingBackgroundTasks ?? [];
  const presentation = presentPendingBackgroundWork(tasks, m);
  // Output streams only while this sheet is open.
  const outputSource = (taskId: string): BackgroundWorkOutputSource | null => {
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    const source = task === undefined ? null : backgroundWorkOutputSource(task, turnItems ?? []);
    if (source?.kind === "item") return streamsOutput ? source : null;
    return source?.kind === "task" && streamsTaskOutput ? source : null;
  };
  const openThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
  };
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {presentation === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          <T>Nothing running in the background.</T>
        </Text>
      ) : (
        presentation.items.map((item) => (
          <BackgroundWorkRow
            key={item.taskId}
            environmentId={target.environmentId}
            threadId={target.threadId}
            item={item}
            output={outputSource(item.taskId)}
            onOpen={openThread}
          />
        ))
      )}
    </ScrollView>
  );
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={gt("Background work")} onClose={() => navigation.goBack()} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}

function BackgroundWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly item: PendingBackgroundWorkItem;
  readonly output: BackgroundWorkOutputSource | null;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { item, output } = props;
  const gt = useGT();
  const m = useMessages();
  const { themeAppearance } = useAppearancePreferences();
  const childThreadId = item.childThreadId;
  const row = (
    <View
      className={`flex-row items-center gap-3 py-3.5 ${output === null ? "border-b border-border" : ""}`}
    >
      <SymbolView
        name={
          item.kind === "subagent" ? "person.2" : item.kind === "monitor" ? "clock" : "terminal"
        }
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text className="font-t3-medium text-sm text-foreground">{item.label}</Text>
        <Text className="text-xs text-foreground-muted">{m(KIND_LABELS[item.kind])}</Text>
      </View>
      {childThreadId === undefined ? null : (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      )}
    </View>
  );
  if (output !== null) {
    return (
      <View className="border-b border-border pb-3.5">
        {row}
        {item.command ? (
          <Text selectable className="pt-3 font-mono text-xs leading-normal text-foreground">
            $ {item.command}
          </Text>
        ) : null}
        {output.kind === "item" ? (
          <ThreadCommandOutput
            environmentId={props.environmentId}
            threadId={output.threadId ?? props.threadId}
            itemId={output.itemId}
            themeAppearance={themeAppearance}
          />
        ) : (
          <ThreadCommandOutput
            environmentId={props.environmentId}
            threadId={props.threadId}
            taskId={output.taskId}
            themeAppearance={themeAppearance}
          />
        )}
      </View>
    );
  }
  return childThreadId === undefined ? (
    <View accessible>{row}</View>
  ) : (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={gt("Open subagent {label}", { label: item.label })}
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}
