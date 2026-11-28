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
import { useLinkedThreadReach } from "../../state/linkedThread";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ThreadCommandOutput,
  useBackgroundTaskOutput,
  useCommandOutputStreaming,
} from "./thread-command-output";
import { subagentThreadTarget, type SubagentThreadTarget } from "./threadAgentsPresentation";
import { useOpenLinkedThreadRead } from "./useOpenLinkedThread";

const KIND_LABELS = {
  subagent: msg("Subagent"),
  command: msg("Command", { $context: "noun, a running shell command" }),
  monitor: msg("Monitor", { $context: "noun, a background watcher task" }),
  background_task: msg("Background task"),
} as const;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const navigation = useNavigation();
  const openLinkedRead = useOpenLinkedThreadRead();
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const target = route.params;
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const thread = useAtomValue(environmentThreadShells.threadShellAtom(threadRef));
  const detail = useAtomValue(environmentThreadDetails.threadAtom(threadRef));
  const streamsOutput = useCommandOutputStreaming(target.environmentId);
  const streamsTaskOutput = useBackgroundTaskOutput(target.environmentId);
  const pendingTasks = thread?.pendingBackgroundTasks ?? [];
  const turnItems = detail?.projection.turnItems ?? [];
  const presentation = presentPendingBackgroundWork(pendingTasks, m);
  // Output streams only while this sheet is open.
  const outputSource = (taskId: string): BackgroundWorkOutputSource | null => {
    const task = pendingTasks.find((candidate) => candidate.taskId === taskId);
    const source = task === undefined ? null : backgroundWorkOutputSource(task, turnItems);
    if (source?.kind === "item") return streamsOutput ? source : null;
    return source?.kind === "task" && streamsTaskOutput ? source : null;
  };
  const rows = (presentation?.items ?? []).map((item) => {
    const pending = pendingTasks.find((candidate) => candidate.taskId === item.taskId);
    const itemKey = pending?.nativeItemId ?? item.taskId;
    const turnItem = turnItems.findLast((candidate) =>
      pending?.itemId === undefined
        ? (candidate.nativeItemRef?.nativeId || candidate.id) === itemKey
        : candidate.id === pending.itemId,
    );
    const remoteChild =
      item.kind === "subagent" && turnItem?.type === "subagent" ? turnItem.remoteChild : undefined;
    return { item, childThreadId: item.childThreadId ?? null, remoteChild };
  });
  const reach = useLinkedThreadReach(target.environmentId, rows);
  const openThread = (child: SubagentThreadTarget, title: string) => {
    void Haptics.selectionAsync();
    if (child.linked !== undefined) {
      openLinkedRead(child, child.linked, title, { source: target, replace: true });
      return;
    }
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: child.environmentId,
        threadId: child.threadId,
      }),
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
        rows.map((row) => {
          const { item } = row;
          const openTarget =
            item.kind === "subagent"
              ? subagentThreadTarget(row, target.environmentId, reach.ownConnection, reach.isLinked)
              : null;
          return (
            <BackgroundWorkRow
              key={item.taskId}
              environmentId={target.environmentId}
              threadId={target.threadId}
              item={item}
              output={outputSource(item.taskId)}
              openTarget={openTarget}
              onOpen={openThread}
            />
          );
        })
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
  readonly openTarget: SubagentThreadTarget | null;
  readonly onOpen: (child: SubagentThreadTarget, title: string) => void;
}) {
  const { item, output, openTarget } = props;
  const gt = useGT();
  const m = useMessages();
  const { themeAppearance } = useAppearancePreferences();
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
      {openTarget === null ? null : (
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
  return openTarget === null ? (
    <View accessible>{row}</View>
  ) : (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={gt("Open subagent {label}", { label: item.label })}
      onPress={() => props.onOpen(openTarget, item.label)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}
