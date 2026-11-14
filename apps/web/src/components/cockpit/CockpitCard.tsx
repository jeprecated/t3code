import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  fullAccessOverrideExplanation,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type CockpitKeybindingCommand,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { ClockIcon, LockIcon, MapPinIcon } from "lucide-react";
import {
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { COCKPIT_KINDS } from "../../cockpitKinds";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { readLocalApi } from "../../localApi";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { completeTodo, type UndoOutcome } from "../../taskOutcomes";
import { scheduleWaitResolve, undoWaitResolve } from "../../threadWaitResolves";
import {
  formatElapsedDurationLabel,
  formatShortTimestamp,
  formatUpcomingTimestamp,
} from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  approvalDecisions,
  cockpitCardCommands,
  cockpitPrimary,
  detailLinks,
  optionIndexForKey,
  waitResolveNote,
  type CockpitCard as CockpitCardModel,
} from "./cockpit.logic";

export interface CockpitCardHandle {
  /** False when the command does nothing on this card. */
  readonly run: (command: CockpitKeybindingCommand) => boolean;
  /** Number keys: pick option `key` on the current question or decision. */
  readonly pickOption: (key: string) => boolean;
}

/** R has a field to focus: a note, an own answer, or a todo's notes. */
export function cardHasReply(card: CockpitCardModel, questionIndex = 0): boolean {
  return (
    card.type === "wait" ||
    card.type === "todo" ||
    (card.type === "question" && card.input.questions[questionIndex]?.allowCustomAnswer !== false)
  );
}

interface CockpitOutcome {
  readonly label: string;
  readonly undo: UndoOutcome | null;
}

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
}

const APPROVAL_KIND_LABELS: Record<string, string> = {
  command: "Command",
  "file-read": "File read",
  "file-change": "File changes",
  permission: "Permission",
  "mcp-elicitation": "Tool request",
};

export function CockpitCard({
  ref,
  ...props
}: {
  readonly ref: Ref<CockpitCardHandle>;
  readonly item: CockpitItem;
  readonly card: CockpitCardModel;
  readonly shell: EnvironmentThreadShell | null;
  readonly structure: ThreadStructure | null;
  readonly nowMs: number;
  readonly keyLabel: (command: CockpitKeybindingCommand) => string | null;
  readonly onOutcome: (outcome: CockpitOutcome) => void;
  readonly onSnooze: () => void;
  readonly onUnsnooze: () => void;
  readonly onOpenThere: () => void;
  readonly onStep: (step: 1 | -1) => void;
}) {
  const { item, card, shell, keyLabel } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadRef =
    item.threadId === null ? null : scopeThreadRef(item.environmentId, item.threadId);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  const canOperate = useEnvironmentScope(item.environmentId, AuthOrchestrationOperateScope);
  const canResolve = useAtomValue(
    serverEnvironment.resolveThreadWait.permissionAtom(item.environmentId),
  );
  const canEditTodo = useAtomValue(
    serverEnvironment.upsertUserTodo.permissionAtom(item.environmentId),
  );
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const upsertTodo = useAtomCommand(serverEnvironment.upsertUserTodo, { reportFailure: false });

  const [note, setNote] = useState("");
  const [todoNotes, setTodoNotes] = useState(item.todo?.notes ?? "");
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const replyRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const cwd = shell?.worktreePath ?? project?.workspaceRoot;
  const detail = item.wait?.detail ?? null;
  const links = detailLinks(detail ?? item.todo?.notes);
  const primary = cockpitPrimary(card, { note, hasThread: threadRef !== null });
  const commands = cockpitCardCommands(card, {
    hasThread: threadRef !== null,
    hasLinks: links.length > 0,
    hasReply: cardHasReply(card, questionIndex),
  });

  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    const message = failureMessage(result, "An error occurred.");
    if (message !== null) toastManager.add({ type: "error", title, description: message });
    return result._tag !== "Success";
  };

  const resolveWait = (option?: string) => {
    const waiting = shell?.waiting;
    if (item.wait === null || item.threadId === null || !waiting || !canResolve) return;
    const key = scheduleWaitResolve({
      environmentId: item.environmentId,
      threadId: item.threadId,
      threadTitle: item.threadTitle ?? "the thread",
      waitId: item.wait.id,
      setAt: waiting.setAt,
      note: waitResolveNote(item.wait.kind, note, option),
    });
    props.onOutcome({ label: item.title, undo: () => void undoWaitResolve(key) });
  };

  const approve = async (approval: ThreadPendingApproval, decision: ProviderApprovalDecision) => {
    if (item.threadId === null || busy || !canOperate) return;
    setBusy(true);
    const result = await respondToApproval({
      environmentId: item.environmentId,
      input: { threadId: item.threadId, requestId: approval.requestId, decision },
    });
    setBusy(false);
    if (fail("Could not answer the approval", result)) return;
    props.onOutcome({ label: item.title, undo: null });
  };

  const answer = async (input: ThreadPendingUserInput, nextDrafts = drafts) => {
    if (item.threadId === null || busy || !canOperate) return;
    const answers = buildPendingUserInputAnswers(input.questions, nextDrafts);
    if (answers === null) return;
    setBusy(true);
    const result = await respondToUserInput({
      environmentId: item.environmentId,
      input: { threadId: item.threadId, requestId: input.requestId, answers },
    });
    setBusy(false);
    if (fail("Could not send the answer", result)) return;
    props.onOutcome({ label: item.title, undo: null });
  };

  /** Single-choice questions answer on pick; the last one sends. */
  const pickQuestionOption = (input: ThreadPendingUserInput, optionIndex: number) => {
    const question = input.questions[questionIndex];
    const option = question?.options[optionIndex];
    if (question === undefined || option === undefined) return false;
    const nextDrafts = {
      ...drafts,
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        drafts[question.id],
        option.value ?? option.label,
      ),
    };
    setDrafts(nextDrafts);
    if (!question.multiSelect) advanceQuestion(input, nextDrafts);
    return true;
  };

  const advanceQuestion = (input: ThreadPendingUserInput, nextDrafts = drafts) => {
    const progress = derivePendingUserInputProgress(input.questions, nextDrafts, questionIndex);
    if (!progress.canAdvance) return;
    if (progress.isLastQuestion) void answer(input, nextDrafts);
    else setQuestionIndex(progress.questionIndex + 1);
  };

  const saveTodoNotes = async () => {
    if (item.todo === null || todoNotes === (item.todo.notes ?? "")) return;
    const result = await upsertTodo({
      environmentId: item.environmentId,
      input: { id: item.todo.id, notes: todoNotes.trim() || null },
    });
    fail("Could not save the notes", result);
  };

  const runPrimary = () => {
    if (primary === null || busy) return false;
    switch (card.type) {
      case "approval":
        void approve(card.approval, "accept");
        return true;
      case "question":
        advanceQuestion(card.input);
        return true;
      case "wait":
        resolveWait();
        return true;
      case "todo":
        if (item.todo === null || !canEditTodo) return false;
        void saveTodoNotes();
        void completeTodo(item.environmentId, item.todo).then((undo) => {
          if (undo !== null) props.onOutcome({ label: item.title, undo });
        });
        return true;
      default:
        props.onOpenThere();
        return true;
    }
  };

  const run = (command: CockpitKeybindingCommand): boolean => {
    if (!commands.includes(command)) return false;
    switch (command) {
      case "cockpit.primary":
        return runPrimary();
      case "cockpit.approve":
        if (card.type === "approval") void approve(card.approval, "accept");
        return true;
      case "cockpit.approveForThread":
        if (card.type === "approval") void approve(card.approval, "acceptForSession");
        return true;
      case "cockpit.deny":
        if (card.type === "approval") {
          const decisions = approvalDecisions(card.approval);
          void approve(card.approval, decisions.includes("decline") ? "decline" : "cancel");
        }
        return true;
      case "cockpit.reply":
        replyRef.current?.focus();
        return true;
      case "cockpit.openLink": {
        const link = links[0];
        if (link !== undefined) void readLocalApi()?.shell.openExternal(link);
        return true;
      }
      case "cockpit.snooze":
        props.onSnooze();
        return true;
      case "cockpit.openThere":
        props.onOpenThere();
        return true;
      default:
        return false;
    }
  };

  const pickOption = (key: string) => {
    if (card.type === "question") {
      const index = optionIndexForKey(
        key,
        card.input.questions[questionIndex]?.options.length ?? 0,
      );
      return index !== null && pickQuestionOption(card.input, index);
    }
    const options = item.wait?.options ?? [];
    const index = optionIndexForKey(key, options.length);
    if (index === null || !canResolve) return false;
    resolveWait(options[index]);
    return true;
  };

  useImperativeHandle(ref, () => ({ run, pickOption }));

  const { icon: Icon, label: kindLabel, className: kindClassName } = COCKPIT_KINDS[item.kind];
  const message = shell?.source.latestVisibleMessage;
  const excerpt = message?.role === "assistant" ? message.text.trim().slice(0, 400) : "";
  const sinceLabel = formatElapsedDurationLabel(item.since, props.nowMs);
  const kbd = (command: CockpitKeybindingCommand) => {
    const label = keyLabel(command);
    return label ? <Kbd>{label}</Kbd> : null;
  };

  return (
    <article
      tabIndex={-1}
      data-cockpit-region="main"
      aria-label={`${kindLabel}: ${item.title}`}
      className="flex w-full flex-col gap-3 rounded-xl border bg-card p-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide",
            kindClassName,
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {kindLabel}
        </span>
        <span className="flex-1" />
        {item.todo !== null ? (
          <Badge variant="outline">Your todo</Badge>
        ) : item.working ? (
          <Badge variant="info">Agent working</Badge>
        ) : (
          <Badge variant="warning">
            <LockIcon aria-hidden />
            Agent idle · {sinceLabel}
          </Badge>
        )}
        {item.where ? (
          <Badge variant="outline">
            <MapPinIcon aria-hidden />
            {item.where}
          </Badge>
        ) : null}
        {item.notBefore && Date.parse(item.notBefore) > props.nowMs ? (
          <Badge variant="outline">
            <ClockIcon aria-hidden />
            {`after ${formatUpcomingTimestamp(item.notBefore, timestampFormat)}`}
          </Badge>
        ) : null}
      </div>

      {item.until !== null ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
          <ClockIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="flex-1">
            {item.snoozedBy === "thread"
              ? `Its thread is snoozed until ${formatUpcomingTimestamp(item.until, timestampFormat)}`
              : `Snoozed until ${formatUpcomingTimestamp(item.until, timestampFormat)}`}
          </span>
          {item.snoozedBy === "task" ? (
            <Button size="xs" variant="outline" data-roving onClick={props.onUnsnooze}>
              Unsnooze
            </Button>
          ) : null}
        </div>
      ) : null}

      <h2 className="text-lg font-semibold leading-snug">
        {card.type === "question" && card.input.questions.length === 1
          ? (card.input.questions[0]?.question ?? item.title)
          : item.title}
      </h2>

      <Section label="Context">
        <p className="text-sm text-muted-foreground">
          {item.todo !== null ? (
            <>Your todo · added {formatShortTimestamp(item.since, timestampFormat)}</>
          ) : (
            <>
              Asked by{" "}
              <button
                type="button"
                data-roving
                className="cursor-pointer text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={props.onOpenThere}
              >
                {item.threadTitle}
              </button>
              {item.projectTitle ? ` · ${item.projectTitle}` : ""} ·{" "}
              {formatShortTimestamp(item.since, timestampFormat)} ·{" "}
              {item.working ? `asked ${sinceLabel} ago, still working` : `idle ${sinceLabel}`}
            </>
          )}
        </p>
        {excerpt ? (
          <blockquote className="mt-1.5 line-clamp-2 border-s-2 ps-2.5 text-sm text-muted-foreground">
            {excerpt}
          </blockquote>
        ) : null}
      </Section>

      {detail ? (
        <Section label="Details">
          <ChatMarkdown text={detail} cwd={cwd} threadRef={threadRef ?? undefined} />
        </Section>
      ) : null}

      <CardBody
        card={card}
        item={item}
        structure={props.structure}
        drafts={drafts}
        questionIndex={questionIndex}
        note={note}
        todoNotes={todoNotes}
        busy={busy}
        canOperate={canOperate}
        canResolve={canResolve}
        replyRef={replyRef}
        keyLabel={keyLabel}
        onPickQuestionOption={(index) => {
          if (card.type === "question") pickQuestionOption(card.input, index);
        }}
        onCustomAnswer={(value) => {
          if (card.type !== "question") return;
          const question = card.input.questions[questionIndex];
          if (question === undefined) return;
          setDrafts((current) => ({
            ...current,
            [question.id]: setPendingUserInputCustomAnswer(question, current[question.id], value),
          }));
        }}
        onSubmitQuestion={() => {
          if (card.type === "question") advanceQuestion(card.input);
        }}
        onPreviousQuestion={() => setQuestionIndex((index) => Math.max(0, index - 1))}
        onApprove={(decision) => {
          if (card.type === "approval") void approve(card.approval, decision);
        }}
        onPickWaitOption={(option) => resolveWait(option)}
        onNote={setNote}
        onSubmitNote={runPrimary}
        onTodoNotes={setTodoNotes}
        onSaveTodoNotes={() => void saveTodoNotes()}
      />

      <div className="mt-1 flex flex-wrap items-center gap-2 border-t pt-3">
        {primary !== null && card.type !== "approval" ? (
          <Button
            size="sm"
            data-roving
            disabled={busy || (card.type === "wait" && !canResolve)}
            onClick={runPrimary}
          >
            {primary.label}
            {kbd("cockpit.primary")}
          </Button>
        ) : null}
        {card.type !== "loading" ? (
          <Button size="sm" variant="outline" data-roving onClick={props.onSnooze}>
            <ClockIcon aria-hidden />
            Snooze
            {kbd("cockpit.snooze")}
          </Button>
        ) : null}
        {threadRef !== null && primary?.action !== "openThere" ? (
          <Button size="sm" variant="ghost" data-roving onClick={props.onOpenThere}>
            Open there
            {kbd("cockpit.openThere")}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button size="xs" variant="ghost-muted" data-roving onClick={() => props.onStep(-1)}>
          {kbd("cockpit.previous")}
          Back
        </Button>
        <Button size="xs" variant="ghost-muted" data-roving onClick={() => props.onStep(1)}>
          Skip
          {kbd("cockpit.next")}
        </Button>
      </div>
    </article>
  );
}

function Section(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.label}
      </h3>
      {props.children}
    </section>
  );
}

/** A numbered answer: its label, and the provider's description under it. */
function OptionButton(props: {
  readonly index: number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly selected: boolean;
  readonly multiSelect: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
  readonly onSubmit?: () => void;
}) {
  return (
    <button
      type="button"
      data-roving
      aria-pressed={props.selected}
      disabled={props.disabled}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[auto_1fr] items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2 text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-64",
        props.selected && "border-ring bg-muted/70",
      )}
      onClick={props.onPick}
      onKeyDown={(event) => {
        // Space toggles a multiple choice; Enter sends what is chosen.
        if (props.multiSelect && event.key === "Enter" && props.onSubmit) {
          event.preventDefault();
          props.onSubmit();
        }
      }}
    >
      {props.index < 9 ? <Kbd>{props.index + 1}</Kbd> : <span />}
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{props.label}</span>
        {props.description ? (
          <span className="text-xs text-muted-foreground">{props.description}</span>
        ) : null}
      </span>
    </button>
  );
}

function CardBody({
  replyRef,
  ...props
}: {
  readonly card: CockpitCardModel;
  readonly item: CockpitItem;
  readonly structure: ThreadStructure | null;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly note: string;
  readonly todoNotes: string;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly canResolve: boolean;
  readonly replyRef: Ref<HTMLInputElement & HTMLTextAreaElement>;
  readonly keyLabel: (command: CockpitKeybindingCommand) => string | null;
  readonly onPickQuestionOption: (index: number) => void;
  readonly onCustomAnswer: (value: string) => void;
  readonly onSubmitQuestion: () => void;
  readonly onPreviousQuestion: () => void;
  readonly onApprove: (decision: ProviderApprovalDecision) => void;
  readonly onPickWaitOption: (option: string) => void;
  readonly onNote: (value: string) => void;
  readonly onSubmitNote: () => void;
  readonly onTodoNotes: (value: string) => void;
  readonly onSaveTodoNotes: () => void;
}) {
  const { card, item, keyLabel } = props;
  const kbd = (command: CockpitKeybindingCommand) => {
    const label = keyLabel(command);
    return label ? <Kbd>{label}</Kbd> : null;
  };
  const onEnter =
    (submit: () => void) => (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      const multiline = event.currentTarget instanceof HTMLTextAreaElement;
      if (event.key !== "Enter" || (multiline && !(event.metaKey || event.ctrlKey))) return;
      if (!multiline && event.shiftKey) return;
      event.preventDefault();
      submit();
    };

  switch (card.type) {
    case "loading":
      return <p className="text-sm text-muted-foreground">Loading the request…</p>;
    case "approval": {
      const { approval } = card;
      const decisions = approvalDecisions(approval);
      const disabled = props.busy || !props.canOperate;
      return (
        <Section label={APPROVAL_KIND_LABELS[approval.requestKind] ?? "Request"}>
          {approval.detail ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm">
              {approval.detail}
            </pre>
          ) : null}
          {approval.reason ? (
            <p className="text-sm text-muted-foreground">{approval.reason}</p>
          ) : null}
          {approval.fullAccessOverride ? (
            <p className="text-xs text-muted-foreground">
              {fullAccessOverrideExplanation(approval.fullAccessOverride)}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              data-roving
              disabled={disabled}
              onClick={() => props.onApprove("accept")}
            >
              Approve
              {kbd("cockpit.approve")}
            </Button>
            {decisions.includes("acceptForSession") ? (
              <Button
                size="sm"
                variant="outline"
                data-roving
                disabled={disabled}
                onClick={() => props.onApprove("acceptForSession")}
              >
                Approve for this thread
                {kbd("cockpit.approveForThread")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              data-roving
              disabled={disabled}
              onClick={() => props.onApprove(decisions.includes("decline") ? "decline" : "cancel")}
            >
              Deny
              {kbd("cockpit.deny")}
            </Button>
          </div>
        </Section>
      );
    }
    case "question": {
      const { questions } = card.input;
      const question = questions[props.questionIndex] ?? questions[0];
      if (question === undefined) return null;
      const draft = props.drafts[question.id];
      const disabled = props.busy || !props.canOperate;
      return (
        <Section
          label={
            questions.length > 1
              ? `${question.header} · ${props.questionIndex + 1} of ${questions.length}`
              : question.header
          }
        >
          {questions.length > 1 ? <p className="text-sm">{question.question}</p> : null}
          <div className="mt-1 flex flex-col gap-1.5">
            {question.options.map((option, index) => (
              <OptionButton
                key={option.value ?? option.label}
                index={index}
                label={option.label}
                description={option.description}
                multiSelect={question.multiSelect}
                selected={isPendingUserInputOptionSelected(
                  question,
                  draft,
                  option.value ?? option.label,
                )}
                disabled={disabled}
                onPick={() => props.onPickQuestionOption(index)}
                onSubmit={props.onSubmitQuestion}
              />
            ))}
            {question.allowCustomAnswer !== false ? (
              <Input
                ref={replyRef}
                data-roving
                aria-label="Your own answer"
                placeholder="Other… your own answer, Enter sends it"
                value={draft?.customAnswer ?? ""}
                disabled={disabled}
                onChange={(event) => props.onCustomAnswer(event.target.value)}
                onKeyDown={onEnter(props.onSubmitQuestion)}
              />
            ) : null}
          </div>
          {props.questionIndex > 0 ? (
            <div>
              <Button
                size="xs"
                variant="ghost-muted"
                data-roving
                onClick={props.onPreviousQuestion}
              >
                Previous question
              </Button>
            </div>
          ) : null}
        </Section>
      );
    }
    case "wait": {
      const options = item.wait?.options ?? [];
      return (
        <>
          {options.length > 0 ? (
            <Section label="Options">
              <div className="flex flex-col gap-1.5">
                {options.map((option, index) => (
                  <OptionButton
                    key={option}
                    index={index}
                    label={option}
                    selected={false}
                    multiSelect={false}
                    disabled={!props.canResolve}
                    onPick={() => props.onPickWaitOption(option)}
                  />
                ))}
              </div>
            </Section>
          ) : null}
          <Input
            ref={replyRef}
            data-roving
            aria-label={card.kind === "review" ? "Feedback for the agent" : "Note for the agent"}
            placeholder={
              card.kind === "review"
                ? "Feedback for the agent; empty means it looks good"
                : "Note for the agent (optional)"
            }
            value={props.note}
            disabled={!props.canResolve}
            onChange={(event) => props.onNote(event.target.value)}
            onKeyDown={onEnter(props.onSubmitNote)}
          />
        </>
      );
    }
    case "todo":
      return (
        <Section label="Notes">
          <Textarea
            ref={replyRef}
            data-roving
            size="sm"
            aria-label="Notes"
            placeholder="Notes"
            value={props.todoNotes}
            onChange={(event) => props.onTodoNotes(event.target.value)}
            onBlur={props.onSaveTodoNotes}
            onKeyDown={onEnter(props.onSaveTodoNotes)}
          />
        </Section>
      );
    case "elsewhere":
      return <ElsewhereHint item={item} structure={props.structure} />;
  }
}

function ElsewhereHint(props: {
  readonly item: CockpitItem;
  readonly structure: ThreadStructure | null;
}) {
  const ask = props.structure?.turnItems.findLast(
    (turnItem) =>
      (turnItem.type === "secret_request" && turnItem.secretStatus === "pending") ||
      (turnItem.type === "link_request" && turnItem.linkStatus === "pending"),
  );
  const secret = ask?.type === "secret_request";
  const link = ask?.type === "link_request";
  const reason = secret || link ? ask.reason : null;
  const text = secret
    ? "The agent asks for a secret. Enter it in the thread; it never shows in chat."
    : link
      ? "The agent asks you to link another environment. Choose the machine in the thread."
      : props.item.kind === "plan"
        ? "Read the proposed plan and approve or change it in the thread."
        : props.item.kind === "fix"
          ? "Retry, switch model or continue in the thread."
          : "Answer this in the thread.";
  return (
    <div className="flex flex-col gap-1">
      {reason ? <p className="text-sm">{reason}</p> : null}
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
