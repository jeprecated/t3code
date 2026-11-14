import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  taskWaitKey,
  type OrchestrationV2ThreadWait,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { TASK_SNOOZE_PRESETS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon, HandIcon, MapPinIcon } from "lucide-react";
import { useState } from "react";

import { COCKPIT_KINDS } from "../../cockpitKinds";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { clearTaskSnooze, snoozeTask } from "../../taskOutcomes";
import {
  isWaitResolvePending,
  scheduleWaitResolve,
  usePendingWaitResolves,
  waitResolveKey,
} from "../../threadWaitResolves";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { requestSnoozeTime } from "../SnoozePrompt";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ComposerBanner } from "./ComposerBanner";

/** What the thread's agent declared it waits on from the user, above the composer. */
export function ThreadWaitsStrip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const pending = usePendingWaitResolves((state) => state.pending);
  const snoozes = useAtomValue(
    serverEnvironment.taskSnoozesLive({ environmentId: props.threadRef.environmentId, input: {} }),
  );
  // The subscription does not re-send when a snooze ends.
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const waiting = shell?.waiting ?? null;
  if (shell === null || waiting === null) return null;
  const waits = waiting.items.filter(
    (wait) =>
      !isWaitResolvePending(
        pending,
        waitResolveKey(shell.environmentId, shell.id, wait.id),
        waiting.setAt,
      ),
  );
  if (waits.length === 0) return null;
  const snoozedUntil = new Map(
    (AsyncResult.getOrElse(snoozes, () => null)?.snoozes ?? []).flatMap((snooze) =>
      Date.parse(snooze.snoozedUntil) > nowMs ? [[snooze.key, snooze.snoozedUntil] as const] : [],
    ),
  );
  return (
    <WaitsStrip
      threadRef={props.threadRef}
      cwd={props.cwd}
      shell={shell}
      setAt={waiting.setAt}
      waits={waits}
      snoozedUntil={snoozedUntil}
    />
  );
}

function WaitsStrip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly shell: EnvironmentThreadShell;
  readonly setAt: string;
  readonly waits: ReadonlyArray<OrchestrationV2ThreadWait>;
  /** By task key, snoozes still in effect. */
  readonly snoozedUntil: ReadonlyMap<string, string>;
}) {
  const { threadRef, shell, waits } = props;
  const [showSnoozed, setShowSnoozed] = useState(false);
  const canResolve = useAtomValue(
    serverEnvironment.resolveThreadWait.permissionAtom(threadRef.environmentId),
  );
  const canSnooze = useAtomValue(
    serverEnvironment.setTaskSnooze.permissionAtom(threadRef.environmentId),
  );
  const working = isThreadWorking(shell);
  const snoozedCount = waits.filter((wait) =>
    props.snoozedUntil.has(taskWaitKey(threadRef.threadId, wait.id)),
  ).length;
  const shown = showSnoozed
    ? waits
    : waits.filter((wait) => !props.snoozedUntil.has(taskWaitKey(threadRef.threadId, wait.id)));

  const resolve = (wait: OrchestrationV2ThreadWait, note: string | undefined) =>
    scheduleWaitResolve({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      threadTitle: shell.title,
      waitId: wait.id,
      setAt: props.setAt,
      note,
    });
  const snooze = async (wait: OrchestrationV2ThreadWait) => {
    const choice = await requestSnoozeTime(threadRef.environmentId, {
      presets: TASK_SNOOZE_PRESETS,
    });
    if (!choice) return;
    await snoozeTask({
      environmentId: threadRef.environmentId,
      key: taskWaitKey(threadRef.threadId, wait.id),
      snoozedUntil: choice.snoozedUntil,
    });
  };

  if (shown.length === 0 && snoozedCount === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        variant={working || shown.length === 0 ? "default" : "warning"}
        density="comfortable"
        data-chat-composer-collapsed-controls="true"
      >
        <ComposerBanner.Row layout="wrap-actions">
          <ComposerBanner.Icon>
            <HandIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="font-medium">Waiting on you · {waits.length - snoozedCount}</span>
            {working ? (
              <span className="truncate text-muted-foreground">The agent is still working</span>
            ) : null}
          </ComposerBanner.Content>
          {snoozedCount > 0 ? (
            <ComposerBanner.Actions>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-expanded={showSnoozed}
                onClick={() => setShowSnoozed((value) => !value)}
              >
                {snoozedCount} snoozed
              </Button>
            </ComposerBanner.Actions>
          ) : null}
        </ComposerBanner.Row>
        <ComposerBanner.Children>
          {shown.map((wait) => (
            <ThreadWaitCard
              key={wait.id}
              wait={wait}
              cwd={props.cwd}
              threadRef={threadRef}
              canResolve={canResolve}
              canSnooze={canSnooze}
              snoozedUntil={
                props.snoozedUntil.get(taskWaitKey(threadRef.threadId, wait.id)) ?? null
              }
              onResolve={(note) => resolve(wait, note)}
              onSnooze={() => void snooze(wait)}
              onUnsnooze={() =>
                void clearTaskSnooze(
                  threadRef.environmentId,
                  taskWaitKey(threadRef.threadId, wait.id),
                )
              }
            />
          ))}
        </ComposerBanner.Children>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function ThreadWaitCard(props: {
  readonly wait: OrchestrationV2ThreadWait;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly canResolve: boolean;
  readonly canSnooze: boolean;
  readonly snoozedUntil: string | null;
  readonly onResolve: (note: string | undefined) => void;
  readonly onSnooze: () => void;
  readonly onUnsnooze: () => void;
}) {
  const { wait } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const [detailOpen, setDetailOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const { icon: Icon, label, className } = COCKPIT_KINDS[wait.kind];
  const done = () => props.onResolve(note);

  return (
    <div className="flex flex-col gap-1 py-0.5">
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className={className}>
          <Icon aria-label={label} />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="min-w-0 flex-wrap">
          <span className={cn("min-w-0 truncate", props.snoozedUntil && "text-muted-foreground")}>
            {wait.summary}
          </span>
          {props.snoozedUntil ? (
            <Badge variant="outline" size="sm">
              {`until ${formatUpcomingTimestamp(props.snoozedUntil, timestampFormat)}`}
            </Badge>
          ) : null}
          {wait.where ? (
            <Badge variant="outline" size="sm">
              <MapPinIcon aria-hidden />
              {wait.where}
            </Badge>
          ) : null}
          {wait.notBefore && Date.parse(wait.notBefore) > nowMs ? (
            <Badge variant="outline" size="sm">
              {`after ${formatUpcomingTimestamp(wait.notBefore, timestampFormat)}`}
            </Badge>
          ) : null}
          {wait.detail ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-expanded={detailOpen}
              aria-label={detailOpen ? "Hide details" : "Show details"}
              onClick={() => setDetailOpen((open) => !open)}
            >
              <ChevronDownIcon className={cn(!detailOpen && "-rotate-90")} />
            </Button>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {wait.options?.map((option) => (
            <Button
              key={option}
              size="xs"
              variant="outline"
              disabled={!props.canResolve}
              onClick={() => props.onResolve(`Chose: ${option}`)}
            >
              {option}
            </Button>
          ))}
          <Button
            size="xs"
            variant={wait.options?.length ? "ghost" : "outline"}
            disabled={!props.canResolve}
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((open) => !open)}
          >
            Done…
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!props.canSnooze}
            onClick={props.snoozedUntil ? props.onUnsnooze : props.onSnooze}
          >
            {props.snoozedUntil ? "Unsnooze" : "Snooze"}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {detailOpen && wait.detail ? (
        <ComposerBanner.Body>
          <ChatMarkdown text={wait.detail} cwd={props.cwd} threadRef={props.threadRef} />
        </ComposerBanner.Body>
      ) : null}
      {noteOpen ? (
        <ComposerBanner.Body>
          <div className="flex items-center gap-1 pe-1">
            <Input
              size="compact"
              autoFocus
              aria-label="Note for the agent"
              placeholder="Note for the agent (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNoteOpen(false);
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                done();
              }}
            />
            <Button size="xs" disabled={!props.canResolve} onClick={done}>
              Done
            </Button>
          </div>
        </ComposerBanner.Body>
      ) : null}
    </div>
  );
}
