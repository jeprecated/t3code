import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { youQueueWaitKey } from "@t3tools/client-runtime/state/you-queue";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ThreadWait,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, HandIcon, MapPinIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  isWaitResolvePending,
  scheduleWaitResolve,
  usePendingWaitResolves,
} from "../../threadWaitResolves";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { openNextYouQueueItem } from "../../youQueue";
import { YOU_QUEUE_KINDS } from "../../youQueueKinds";
import ChatMarkdown from "../ChatMarkdown";
import { requestSnoozeTime } from "../SnoozePrompt";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";

/** What the thread's agent declared it waits on from the user, above the composer. */
export function ThreadWaitsStrip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const pending = usePendingWaitResolves((state) => state.pending);
  const waiting = shell?.waiting ?? null;
  if (shell === null || waiting === null) return null;
  const waits = waiting.items.filter(
    (wait) =>
      !isWaitResolvePending(
        pending,
        youQueueWaitKey(shell.environmentId, shell.id, wait.id),
        waiting.setAt,
      ),
  );
  if (waits.length === 0) return null;
  return (
    <WaitsStrip
      threadRef={props.threadRef}
      cwd={props.cwd}
      shell={shell}
      setAt={waiting.setAt}
      waits={waits}
    />
  );
}

function WaitsStrip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly shell: EnvironmentThreadShell;
  readonly setAt: string;
  readonly waits: ReadonlyArray<OrchestrationV2ThreadWait>;
}) {
  const { threadRef, shell, waits } = props;
  const router = useRouter();
  const notHereKeys = useUiStateStore((state) => state.youNotHereKeys);
  const setYouNotHere = useUiStateStore((state) => state.setYouNotHere);
  const canResolve = useAtomValue(
    serverEnvironment.resolveThreadWait.permissionAtom(threadRef.environmentId),
  );
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const { snoozeThread } = useThreadActions();
  const working = isThreadWorking(shell);

  const resolve = (wait: OrchestrationV2ThreadWait, note: string | undefined) =>
    scheduleWaitResolve({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      threadTitle: shell.title,
      waitId: wait.id,
      setAt: props.setAt,
      note,
    });
  const later = async () => {
    const now = new Date().toISOString();
    if (!canSnooze(shell, { now })) {
      toastManager.add({ type: "error", title: "This thread cannot be snoozed right now" });
      return;
    }
    const choice = await requestSnoozeTime(threadRef.environmentId);
    if (!choice) return;
    const result = await snoozeThread(threadRef, choice.snoozedUntil);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to snooze thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        variant={working ? "default" : "warning"}
        density="comfortable"
        data-chat-composer-collapsed-controls="true"
      >
        <ComposerBanner.Row layout="wrap-actions">
          <ComposerBanner.Icon>
            <HandIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="font-medium">Waiting on you · {waits.length}</span>
            {working ? (
              <span className="truncate text-muted-foreground">The agent is still working</span>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button size="xs" variant="ghost" onClick={() => openNextYouQueueItem(router)}>
              Next
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Children>
          {waits.map((wait) => {
            const key = youQueueWaitKey(threadRef.environmentId, threadRef.threadId, wait.id);
            const notHere = notHereKeys.includes(key);
            return (
              <ThreadWaitCard
                key={wait.id}
                wait={wait}
                cwd={props.cwd}
                threadRef={threadRef}
                canResolve={canResolve}
                canSnooze={canOperate}
                notHere={notHere}
                onResolve={(note) => resolve(wait, note)}
                onLater={() => void later()}
                onToggleNotHere={() => setYouNotHere(key, !notHere)}
              />
            );
          })}
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
  readonly notHere: boolean;
  readonly onResolve: (note: string | undefined) => void;
  readonly onLater: () => void;
  readonly onToggleNotHere: () => void;
}) {
  const { wait } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [detailOpen, setDetailOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const { icon: Icon, label, className } = YOU_QUEUE_KINDS[wait.kind];
  const done = () => props.onResolve(note);

  return (
    <div className="flex flex-col gap-1 py-0.5">
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className={className}>
          <Icon aria-label={label} />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="min-w-0 flex-wrap">
          <span className={cn("min-w-0 truncate", props.notHere && "text-muted-foreground")}>
            {wait.summary}
          </span>
          {wait.where ? (
            <Badge variant="outline" size="sm">
              <MapPinIcon aria-hidden />
              {wait.where}
            </Badge>
          ) : null}
          {wait.notBefore ? (
            <Badge variant="outline" size="sm">
              after {formatUpcomingTimestamp(wait.notBefore, timestampFormat)}
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
            onClick={props.onLater}
          >
            Later
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={props.onToggleNotHere}>
            {props.notHere ? "Here again" : "Not here"}
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
