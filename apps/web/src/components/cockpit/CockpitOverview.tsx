import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpIcon, BotIcon, ChevronRightIcon, CircleDashedIcon } from "lucide-react";
import { useRef, useState, type Ref } from "react";

import { overviewEnvironmentIdAtom, overviewThreadKeyAtom } from "../../cockpit";
import { cn, newMessageId } from "../../lib/utils";
import {
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  useAssistantMessageText,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const TRANSCRIPT_LIMIT = 20;
const QUICK_PROMPTS = ["Sweep my chats now", "What can I do from my phone?"] as const;
const ADD_TODO_PREFIX = "Add todo: ";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return true;
}

/** What a new thread on this environment would use, so the overview never falls back to an unauthenticated provider. */
function newThreadModelSelection(environmentId: EnvironmentId) {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = config?.providers ?? [];
  return settings.defaultModelSelection
    ? resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection)
    : resolveProjectDefaultProviderModelSelection(providers, settings, null);
}

/** The overview agent: its recent transcript and a composer to tell it what you did. */
export function CockpitOverview({ regionRef }: { readonly regionRef: Ref<HTMLElement> }) {
  const environmentId = useAtomValue(overviewEnvironmentIdAtom);
  const overviewKey = useAtomValue(overviewThreadKeyAtom);
  const threadRef = overviewKey === null ? null : parseScopedThreadKey(overviewKey);
  const shell = useQuietThreadShell(threadRef);
  const live = shell !== null && shell.archivedAt === null && shell.deletedAt === null;

  return (
    <section
      ref={regionRef}
      data-cockpit-region="overview"
      aria-label="Overview agent"
      className="flex min-h-0 flex-col"
    >
      <h3 className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-semibold">
        <BotIcon aria-hidden className="size-3.5" />
        Overview agent
        {live && isThreadWorking(shell) ? (
          <span className="ms-auto inline-flex items-center gap-1 font-normal text-info-foreground">
            <CircleDashedIcon aria-hidden className="size-3" />
            Working
          </span>
        ) : null}
      </h3>
      {live && threadRef !== null ? (
        <OverviewThread
          threadRef={threadRef}
          runtimeMode={shell.runtimeMode}
          interactionMode={shell.interactionMode}
        />
      ) : environmentId !== null ? (
        <StartOverview environmentId={environmentId} />
      ) : null}
    </section>
  );
}

function StartOverview(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const canStart = useAtomValue(serverEnvironment.startOverview.permissionAtom(environmentId));
  const start = useAtomCommand(serverEnvironment.startOverview, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-start gap-2 p-3 text-sm text-muted-foreground">
      <p>
        Tell it what you did, such as “the Stripe key is in”, and it resolves the matching waits and
        wakes those threads. It also sweeps your threads every morning for asks nobody recorded.
      </p>
      <Button
        size="sm"
        variant="outline"
        data-roving
        data-cockpit-entry
        disabled={!canStart || starting}
        onClick={async () => {
          setStarting(true);
          const modelSelection = newThreadModelSelection(environmentId);
          const result = await start({
            environmentId,
            input: modelSelection === null ? {} : { modelSelection },
          });
          setStarting(false);
          reportFailure("Could not start the overview agent", result);
        }}
      >
        <BotIcon />
        {starting ? "Starting overview agent…" : "Start overview agent"}
      </Button>
    </div>
  );
}

const TOOL_TYPES = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
]);

function OverviewThread(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const { threadRef } = props;
  const items = useQuietThreadVisibleTurnItems(threadRef)
    .filter(
      (row) =>
        row.item.type === "user_message" ||
        row.item.type === "assistant_message" ||
        TOOL_TYPES.has(row.item.type),
    )
    .slice(-TRANSCRIPT_LIMIT);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = async (value: string) => {
    const message = value.trim();
    if (!message || sending) return;
    setSending(true);
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
      },
    });
    setSending(false);
    if (!reportFailure("Could not send to the overview agent", result) && value === text) {
      setText("");
    }
  };

  const lastId = items.at(-1)?.item.id;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {items.length === 0 ? (
          <p className="text-muted-foreground">No messages yet.</p>
        ) : (
          items.map((row) => <TranscriptRow key={row.item.id} threadRef={threadRef} row={row} />)
        )}
        {/* Remounts with each new item, so the transcript opens and stays at its end. */}
        <div
          key={lastId}
          ref={(element) => {
            const scroller = element?.parentElement;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5 border-t p-2">
        <div className="flex flex-wrap gap-1">
          {QUICK_PROMPTS.map((prompt) => (
            <Button
              key={prompt}
              size="xs"
              variant="outline"
              data-roving
              disabled={sending}
              onClick={() => void send(prompt)}
            >
              {prompt}
            </Button>
          ))}
          <Button
            size="xs"
            variant="outline"
            data-roving
            onClick={() => {
              setText(ADD_TODO_PREFIX);
              textareaRef.current?.focus();
            }}
          >
            Add todo…
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <Textarea
            ref={textareaRef}
            size="sm"
            data-roving
            data-cockpit-entry
            aria-label="Message the overview agent"
            placeholder="Tell the overview agent what you did…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send(text);
            }}
          />
          <Button
            size="icon-sm"
            aria-label="Send"
            data-roving
            disabled={sending || !text.trim()}
            onClick={() => void send(text)}
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </>
  );
}

function TranscriptRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly row: ThreadStructureVisibleTurnItem;
}) {
  const { item } = props.row;
  const assistantText = useAssistantMessageText(
    item.type === "assistant_message" ? props.threadRef : null,
    item.id,
  );
  const [open, setOpen] = useState(false);
  if (item.type === "user_message") {
    return (
      <div className="mb-3 flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-xl border bg-muted/40 px-2.5 py-1.5">
          {item.text}
        </p>
      </div>
    );
  }
  if (item.type === "assistant_message") {
    return assistantText ? (
      <div className="mb-3">
        <ChatMarkdown text={assistantText} cwd={undefined} threadRef={props.threadRef} />
      </div>
    ) : null;
  }
  const { name, detail } = toolSummary(item);
  return (
    <div className="mb-1">
      <button
        type="button"
        data-roving
        aria-expanded={open}
        className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-start text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0", open && "rotate-90")} />
        <span className="shrink-0 font-mono text-foreground">{name}</span>
        <span className="min-w-0 truncate">{detail.split("\n")[0]}</span>
      </button>
      {open && detail ? (
        <pre className="mx-1.5 mt-0.5 mb-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

function toolSummary(item: ThreadStructureVisibleTurnItem["item"]): {
  readonly name: string;
  readonly detail: string;
} {
  switch (item.type) {
    case "command_execution":
      return { name: "shell", detail: item.input };
    case "dynamic_tool":
      return {
        // MCP tools arrive as mcp__<server>__<tool>; the tool name alone reads better.
        name: (item.toolName ?? item.title ?? "tool").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""),
        detail: item.input === undefined ? "" : JSON.stringify(item.input, null, 2),
      };
    case "file_change":
      return { name: "edit", detail: item.fileName };
    case "file_search":
      return { name: "search", detail: item.pattern ?? "" };
    case "web_search":
      return { name: "web", detail: item.patterns?.join(", ") ?? "" };
    default:
      return { name: item.type, detail: item.title ?? "" };
  }
}
