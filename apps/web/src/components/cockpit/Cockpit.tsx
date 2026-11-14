import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  COCKPIT_KEYBINDING_COMMANDS,
  type CockpitKeybindingCommand,
  type KeybindingCommand,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { TASK_SNOOZE_PRESETS } from "@t3tools/contracts/settings";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { useCockpitQueue } from "../../cockpit";
import { setCockpitOpen, useCockpitStore } from "../../cockpitStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { shortcutLabelForCommand } from "../../keybindings";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { isEditableFocused } from "../../lib/editableFocus";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { clearTaskSnooze, snoozeTask, type UndoOutcome } from "../../taskOutcomes";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { SnoozePrompt } from "../SnoozePrompt";
import { Button } from "../ui/button";
import { CommandDialog } from "../ui/command";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { CockpitCard, cardHasReply, type CockpitCardHandle } from "./CockpitCard";
import { CockpitList } from "./CockpitList";
import { CockpitOverview, useOverviewThread } from "./CockpitOverview";
import {
  citationQuote,
  cockpitCardCommands,
  detailLinks,
  OVERVIEW_ENTRY,
  resolveCockpitCard,
  resolveSelection,
  rovingTarget,
  stepKey,
  type CockpitRegion,
  type CockpitSelection,
} from "./cockpit.logic";

const LABEL_CONTEXT = { context: { cockpitOpen: true, editableFocus: false } } as const;

const COMMAND_DESCRIPTIONS: Record<CockpitKeybindingCommand | "cockpit.toggle", string> = {
  "cockpit.toggle": "Open or close the cockpit",
  "cockpit.primary": "Done: answer, approve, resolve or complete the task",
  "cockpit.snooze": "Snooze the task",
  "cockpit.openThere": "Open its thread at the message; on the overview agent, its thread",
  "cockpit.next": "Next entry in the list",
  "cockpit.previous": "Previous entry in the list",
  "cockpit.approve": "Approve",
  "cockpit.approveForThread": "Approve for this thread",
  "cockpit.deny": "Deny",
  "cockpit.reply": "Write a note, your own answer, or feedback",
  "cockpit.openLink": "Open the first link in the details",
  "cockpit.undo": "Undo the last outcome",
  "cockpit.focusOverview": "Select the overview agent and write to it",
  "cockpit.help": "Show or hide these keys",
};

const FIXED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["1–9", "Pick an option"],
  ["Space", "Toggle an option that allows several"],
  ["Enter", "In the list, go into the entry; in a field, send"],
  ["Tab / Shift+Tab", "Move between the list and the selected entry"],
  ["Arrows", "In the list, select; in the entry, move between its controls"],
  ["Esc", "Back to the list, then close"],
];

function regionOf(element: Element | null): CockpitRegion | null {
  const region = element?.closest("[data-cockpit-region]")?.getAttribute("data-cockpit-region");
  return region === "list" || region === "main" ? region : null;
}

function rovingItems(region: Element): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>("[data-roving]")].filter(
    (element) => !(element as HTMLButtonElement).disabled,
  );
}

const selectedRow = (root: Element | null | undefined) =>
  root?.querySelector<HTMLElement>('[data-cockpit-region="list"] [aria-current="true"]') ?? null;

/** Mounted with the app; the cockpit itself mounts only while open. */
export function CockpitHost() {
  const open = useCockpitStore((state) => state.open);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          setCockpitOpen(true);
          return;
        }
        if (details.reason === "escape-key") {
          if (useCockpitStore.getState().helpOpen) {
            details.cancel();
            useCockpitStore.setState({ helpOpen: false });
            return;
          }
          const active = document.activeElement;
          const row = selectedRow(popupRef.current);
          if (
            row &&
            active !== row &&
            popupRef.current?.contains(active) &&
            regionOf(active) !== "list"
          ) {
            details.cancel();
            row.focus();
            return;
          }
        }
        setCockpitOpen(false);
      }}
    >
      <DialogPopup
        ref={popupRef}
        aria-label="Cockpit"
        showCloseButton={false}
        className="h-[92vh] w-[92vw] max-w-[92vw]"
        initialFocus={() => selectedRow(popupRef.current) ?? true}
        finalFocus={() => {
          const target = useCockpitStore.getState().returnFocus;
          if (target instanceof HTMLElement && target.isConnected) target.focus();
          return false;
        }}
      >
        {open ? <Cockpit /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function Cockpit() {
  const router = useRouter();
  const queue = useCockpitQueue();
  const overview = useOverviewThread();
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const helpOpen = useCockpitStore((state) => state.helpOpen);
  const [acted, setActed] = useState<ReadonlySet<string>>(() => new Set());
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [snoozing, setSnoozing] = useState<{
    readonly item: CockpitItem;
    readonly returnFocus: Element | null;
  } | null>(null);
  const [focused, setFocused] = useState<{
    readonly region: CockpitRegion;
    readonly field: boolean;
  }>({
    region: "list",
    field: false,
  });
  const lastUndo = useRef<{ readonly key: string; readonly undo: UndoOutcome } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardHandle = useRef<CockpitCardHandle>(null);

  const now = queue.now.filter((item) => !acted.has(item.key));
  const entries = [
    OVERVIEW_ENTRY,
    ...now.map((item) => item.key),
    ...(snoozedExpanded ? queue.snoozed.map((item) => item.key) : []),
  ];
  // Reopening keeps the last entry; otherwise the first task, just after the overview.
  const [storedSelection, setSelection] = useState<CockpitSelection>(() => ({
    key: useCockpitStore.getState().lastSelectedKey ?? "",
    index: 1,
  }));
  const selection = resolveSelection(entries, storedSelection);
  if (selection !== storedSelection) setSelection(selection);
  const onOverview = selection.key === OVERVIEW_ENTRY;
  const current = onOverview
    ? null
    : ([...now, ...queue.snoozed].find((item) => item.key === selection.key) ?? null);

  const threadRef =
    current?.threadId == null ? null : scopeThreadRef(current.environmentId, current.threadId);
  const shell = useQuietThreadShell(threadRef);
  const needsRequests =
    current !== null &&
    (current.kind === "approval" || current.kind === "question") &&
    current.requestId !== null;
  const structure = useQuietThreadProjection(needsRequests ? threadRef : null)?.projection ?? null;
  const card =
    current === null
      ? null
      : resolveCockpitCard(current, structure ? derivePendingThreadRequests(structure) : null);
  const cardCommands =
    current === null || card === null
      ? []
      : cockpitCardCommands(card, {
          hasThread: threadRef !== null,
          hasLinks: detailLinks(current.wait?.detail ?? current.todo?.notes).length > 0,
          hasReply: cardHasReply(card),
        });
  const optionCount =
    card?.type === "question"
      ? (card.input.questions[0]?.options.length ?? 0)
      : (current?.wait?.options?.length ?? 0);

  const keyLabel = (command: KeybindingCommand) =>
    shortcutLabelForCommand(keybindings, command, LABEL_CONTEXT);
  const longest = now
    .filter((item) => !item.working && item.todo === null)
    .reduce<CockpitItem | null>(
      (oldest, item) =>
        oldest === null || Date.parse(item.since) < Date.parse(oldest.since) ? item : oldest,
      null,
    );

  const mainElement = () =>
    rootRef.current?.querySelector<HTMLElement>('[data-cockpit-region="main"]') ?? null;
  const focusRegion = (region: CockpitRegion) => {
    if (region === "list") {
      selectedRow(rootRef.current)?.focus();
      return;
    }
    const main = mainElement();
    // On the overview agent, going in means writing to it.
    (main?.querySelector<HTMLElement>("[data-cockpit-composer]") ?? main)?.focus();
  };

  const selectInPlace = (key: string) => {
    if (key === selection.key && key === storedSelection.key) return;
    const at = entries.indexOf(key);
    setSelection({ key, index: at < 0 ? selection.index : at });
    useCockpitStore.setState({ lastSelectedKey: key });
  };
  /** Moves the selection; focus stays in the region it was in. */
  const select = (key: string, focusIn = regionOf(document.activeElement)) => {
    flushSync(() => selectInPlace(key));
    const row = selectedRow(rootRef.current);
    row?.scrollIntoView({ block: "nearest" });
    if (focusIn === "list") row?.focus();
    else if (focusIn === "main") mainElement()?.focus();
  };
  const step = (direction: 1 | -1) => {
    const target = stepKey(entries, selection.key, direction);
    if (target !== null) select(target);
  };
  const finish = (item: CockpitItem, undo: UndoOutcome | null) => {
    const region = regionOf(document.activeElement) ?? "main";
    flushSync(() => {
      setActed((previous) => new Set(previous).add(item.key));
      // An answer can land after the user stepped elsewhere; stay where they are then.
      setSelection((previous) =>
        previous.key === item.key
          ? resolveSelection(
              entries.filter((key) => key !== item.key),
              previous,
            )
          : previous,
      );
    });
    lastUndo.current = undo === null ? null : { key: item.key, undo };
    if (
      !rootRef.current?.contains(document.activeElement) ||
      regionOf(document.activeElement) === null
    ) {
      if (region === "list") selectedRow(rootRef.current)?.focus();
      else mainElement()?.focus();
    }
  };
  const undoLast = () => {
    const last = lastUndo.current;
    if (last === null) {
      toastManager.add({ type: "info", title: "Nothing to undo", timeout: 2_000 });
      return;
    }
    lastUndo.current = null;
    last.undo();
    flushSync(() =>
      setActed((previous) => {
        const nextActed = new Set(previous);
        nextActed.delete(last.key);
        return nextActed;
      }),
    );
    select(last.key);
  };
  const openThread = (ref: ScopedThreadRef) => {
    useCockpitStore.setState({ open: false, returnFocus: null });
    void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  const openThere = (item: CockpitItem, threadShell: EnvironmentThreadShell | null) => {
    if (item.threadId === null) return;
    const ref = scopeThreadRef(item.environmentId, item.threadId);
    const message = threadShell?.source.latestVisibleMessage;
    const quote = message?.role === "assistant" ? citationQuote(message.text) : null;
    if (!message || quote === null) {
      openThread(ref);
      return;
    }
    useCockpitStore.setState({ open: false, returnFocus: null });
    const start = Math.max(0, message.text.indexOf(quote));
    void router.navigate(
      assistantCitationNavigation({
        version: 1,
        environmentId: item.environmentId,
        threadId: item.threadId,
        messageId: message.id,
        text: quote,
        start,
        end: start + quote.length,
        prefix: "",
        suffix: "",
      }),
    );
  };
  const snooze = async (item: CockpitItem, snoozedUntil: string) => {
    const undo = await snoozeTask({
      environmentId: item.environmentId,
      key: item.taskKey,
      snoozedUntil,
    });
    if (undo !== null) finish(item, undo);
  };

  const runCommand = useEffectEvent((command: CockpitKeybindingCommand): boolean => {
    switch (command) {
      case "cockpit.next":
      case "cockpit.previous":
        step(command === "cockpit.next" ? 1 : -1);
        return true;
      case "cockpit.undo":
        undoLast();
        return true;
      case "cockpit.focusOverview":
        select(OVERVIEW_ENTRY, null);
        focusRegion("main");
        return true;
      case "cockpit.help":
        useCockpitStore.setState({ helpOpen: !useCockpitStore.getState().helpOpen });
        return true;
      default:
        if (!onOverview) return cardHandle.current?.run(command) ?? false;
        if (command !== "cockpit.openThere" || overview.threadRef === null) return false;
        openThread(overview.threadRef);
        return true;
    }
  });
  const blocked = useEffectEvent(() => snoozing !== null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the cockpit's keys live in the app's shortcut dispatcher while it is open
  useEffect(
    () =>
      registerCommands(
        Object.fromEntries(
          COCKPIT_KEYBINDING_COMMANDS.map((command) => [
            command,
            (event: globalThis.KeyboardEvent) => {
              if (!runCommand(command)) return false;
              event.preventDefault();
              event.stopPropagation();
              return true;
            },
          ]),
        ),
        { capture: true, when: () => !blocked() },
      ),
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Nested dialogs bubble through the React tree; only this panel's own keys count.
    const target = event.target;
    if (!(target instanceof HTMLElement) || !rootRef.current?.contains(target)) return;
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      focusRegion(regionOf(target) === "list" ? "main" : "list");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const editable = isEditableFocused(target);
    if (!editable && /^[1-9]$/.test(event.key) && cardHandle.current?.pickOption(event.key)) {
      event.preventDefault();
      return;
    }
    const regionElement = target.closest("[data-cockpit-region]");
    if (regionElement === null) return;
    if (event.key === "Enter" && target.dataset.cockpitRow !== undefined) {
      event.preventDefault();
      focusRegion("main");
      return;
    }
    // A field keeps its arrows, except to step out of it while it is empty.
    if (
      editable &&
      !(
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        (target as HTMLInputElement).value === ""
      )
    ) {
      return;
    }
    // In the list, focus is the selection: each row selects itself as it gains focus.
    const items = rovingItems(regionElement);
    const at = items.indexOf(target.closest<HTMLElement>("[data-roving]") ?? target);
    const goTo = rovingTarget(at, items.length, event.key);
    if (goTo === null) return;
    event.preventDefault();
    items[goTo]?.focus();
  };

  const hintKey = (...commands: ReadonlyArray<KeybindingCommand>) =>
    commands.flatMap((command) => keyLabel(command) ?? []).join(" ") || null;
  const moveHints: ReadonlyArray<readonly [string | null, string]> = [
    [
      [hintKey("cockpit.next", "cockpit.previous"), focused.region === "list" ? "↑↓" : null]
        .filter(Boolean)
        .join(" / ") || null,
      "Move",
    ],
    ["Tab", focused.region === "list" ? "Go in" : "To the list"],
  ];
  const hints: ReadonlyArray<readonly [string | null, string]> =
    onOverview && focused.region === "main" && focused.field
      ? [
          ["Enter", "Send"],
          ["Shift+Enter", "New line"],
          ["↑", "Quick prompts, when empty"],
          ["Tab", "To the list"],
          ["Esc", "Back to the list"],
        ]
      : [
          ...(onOverview
            ? [
                [hintKey("cockpit.focusOverview"), "Write to it"] as const,
                ...(overview.threadRef === null
                  ? []
                  : [[hintKey("cockpit.openThere"), "Open thread"] as const]),
              ]
            : [
                ...cardCommands.map(
                  (command) => [hintKey(command), COMMAND_SHORT_LABELS[command]] as const,
                ),
                ...(optionCount > 0 ? [[`1–${Math.min(9, optionCount)}`, "Pick"] as const] : []),
                [hintKey("cockpit.focusOverview"), "Overview agent"] as const,
              ]),
          ...moveHints,
          [hintKey("cockpit.help"), "All keys"],
          ["Esc", focused.region === "list" ? "Close" : "Back to the list"],
        ];

  return (
    <div
      ref={rootRef}
      className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const region = regionOf(event.target);
        const field = isEditableFocused(event.target);
        if (region !== null && (region !== focused.region || field !== focused.field)) {
          setFocused({ region, field });
        }
      }}
    >
      <header className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Cockpit</h2>
        <span className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{now.length}</span> waiting
          on you
          {longest ? (
            <>
              {" "}
              · longest{" "}
              <span className="font-semibold text-foreground tabular-nums">
                {formatElapsedDurationLabel(longest.since, nowMs)}
              </span>
            </>
          ) : null}
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={() => setCockpitOpen(false)}>
          Close
          <Kbd>Esc</Kbd>
        </Button>
      </header>

      <div className="grid min-h-0 grid-cols-[288px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[minmax(0,40%)_minmax(0,1fr)]">
        <CockpitList
          now={now}
          snoozed={queue.snoozed}
          snoozedExpanded={snoozedExpanded}
          selectedKey={selection.key}
          nowMs={nowMs}
          onToggleSnoozed={() => setSnoozedExpanded((value) => !value)}
          onSelect={selectInPlace}
        />
        {onOverview ? (
          <CockpitOverview
            openThreadLabel={keyLabel("cockpit.openThere")}
            onOpenThread={() => {
              if (overview.threadRef !== null) openThread(overview.threadRef);
            }}
          />
        ) : (
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            {current !== null && card !== null ? (
              <div className="max-w-190">
                <CockpitCard
                  key={current.key}
                  ref={cardHandle}
                  item={current}
                  card={card}
                  shell={shell}
                  structure={structure}
                  nowMs={nowMs}
                  keyLabel={keyLabel}
                  onOutcome={(outcome) => finish(current, outcome.undo)}
                  onSnooze={() =>
                    setSnoozing({ item: current, returnFocus: document.activeElement })
                  }
                  onUnsnooze={() => void clearTaskSnooze(current.environmentId, current.taskKey)}
                  onOpenThere={() => openThere(current, shell)}
                  onStep={step}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        {hints.map(([key, label]) =>
          key ? (
            <span key={label} className="inline-flex items-center gap-1.5">
              <Kbd>{key}</Kbd>
              {label}
            </span>
          ) : null,
        )}
      </footer>

      {helpOpen ? <KeyHelp keyLabel={keyLabel} /> : null}

      <CommandDialog
        open={snoozing !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozing(null);
        }}
      >
        {snoozing !== null ? (
          <SnoozePrompt
            environmentId={snoozing.item.environmentId}
            presets={TASK_SNOOZE_PRESETS}
            returnFocus={snoozing.returnFocus}
            onFinish={(result) => {
              setSnoozing(null);
              if (result !== null && result !== "custom") {
                void snooze(snoozing.item, result.snoozedUntil);
              }
            }}
          />
        ) : null}
      </CommandDialog>
    </div>
  );
}

const COMMAND_SHORT_LABELS: Record<CockpitKeybindingCommand, string> = {
  "cockpit.primary": "Done",
  "cockpit.snooze": "Snooze",
  "cockpit.openThere": "Open there",
  "cockpit.next": "Next",
  "cockpit.previous": "Previous",
  "cockpit.approve": "Approve",
  "cockpit.approveForThread": "For this thread",
  "cockpit.deny": "Deny",
  "cockpit.reply": "Reply",
  "cockpit.openLink": "Open link",
  "cockpit.undo": "Undo",
  "cockpit.focusOverview": "Overview agent",
  "cockpit.help": "All keys",
};

/** Every cockpit key as bound now, so custom bindings show. */
function KeyHelp(props: { readonly keyLabel: (command: KeybindingCommand) => string | null }) {
  const commands = ["cockpit.toggle", ...COCKPIT_KEYBINDING_COMMANDS] as const;
  return (
    <div
      role="dialog"
      aria-label="Cockpit keys"
      className="absolute inset-x-4 bottom-12 z-10 max-h-[70%] overflow-y-auto rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
    >
      <h3 className="mb-2 font-semibold">Keys</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {commands.map((command) => (
          <div key={command} className="contents">
            <dt>
              <Kbd>{props.keyLabel(command) ?? "Unbound"}</Kbd>
            </dt>
            <dd className="text-muted-foreground">{COMMAND_DESCRIPTIONS[command]}</dd>
          </div>
        ))}
        {FIXED_KEYS.map(([key, description]) => (
          <div key={key} className="contents">
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd className="text-muted-foreground">{description}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">Change these in Settings → Keybindings.</p>
    </div>
  );
}
