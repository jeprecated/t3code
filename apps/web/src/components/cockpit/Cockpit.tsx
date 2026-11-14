import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  COCKPIT_KEYBINDING_COMMANDS,
  type CockpitKeybindingCommand,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { TASK_SNOOZE_PRESETS } from "@t3tools/contracts/settings";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { useCockpitQueue } from "../../cockpit";
import { COCKPIT_KINDS } from "../../cockpitKinds";
import { setCockpitOpen, useCockpitStore } from "../../cockpitStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { shortcutLabelForCommand } from "../../keybindings";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { isEditableFocused } from "../../lib/editableFocus";
import { cn } from "../../lib/utils";
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
import { CockpitOverview } from "./CockpitOverview";
import { CockpitUpNext } from "./CockpitUpNext";
import {
  citationQuote,
  cockpitCardCommands,
  cycleRegion,
  detailLinks,
  keyAfter,
  resolveCockpitCard,
  rovingTarget,
  stepKey,
  type CockpitRegion,
} from "./cockpit.logic";

const LABEL_CONTEXT = { context: { cockpitOpen: true, editableFocus: false } } as const;

const COMMAND_DESCRIPTIONS: Record<CockpitKeybindingCommand | "cockpit.toggle", string> = {
  "cockpit.toggle": "Open or close the cockpit",
  "cockpit.primary": "Done: answer, approve, resolve or complete the task",
  "cockpit.snooze": "Snooze the task",
  "cockpit.openThere": "Open its thread at the message",
  "cockpit.next": "Next task; in Up next, the next row",
  "cockpit.previous": "Previous task; in Up next, the previous row",
  "cockpit.approve": "Approve",
  "cockpit.approveForThread": "Approve for this thread",
  "cockpit.deny": "Deny",
  "cockpit.reply": "Write a note, your own answer, or feedback",
  "cockpit.openLink": "Open the first link in the details",
  "cockpit.undo": "Undo the last outcome",
  "cockpit.focusOverview": "Message the overview agent",
  "cockpit.help": "Show or hide these keys",
};

const FIXED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["1–9", "Pick an option"],
  ["Space", "Toggle an option that allows several"],
  ["Enter", "Send the answer or note; in Up next, open the row"],
  ["Tab / Shift+Tab", "Move between the card, Up next and the overview agent"],
  ["Arrows", "Move within an area"],
  ["Esc", "Leave a field, then close"],
];

function regionOf(element: Element | null): CockpitRegion | null {
  const region = element?.closest("[data-cockpit-region]")?.getAttribute("data-cockpit-region");
  return region === "card" || region === "upNext" || region === "overview" ? region : null;
}

function rovingItems(region: Element): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>("[data-roving]")].filter(
    (element) => !(element as HTMLButtonElement).disabled,
  );
}

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
          const card = popupRef.current?.querySelector<HTMLElement>('[data-cockpit-region="card"]');
          if (
            card &&
            active !== card &&
            popupRef.current?.contains(active) &&
            (isEditableFocused(active) || regionOf(active) !== "card")
          ) {
            details.cancel();
            card.focus();
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
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>('[data-cockpit-region="card"]') ?? true
        }
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
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const helpOpen = useCockpitStore((state) => state.helpOpen);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [acted, setActed] = useState<ReadonlySet<string>>(() => new Set());
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [snoozing, setSnoozing] = useState<{
    readonly item: CockpitItem;
    readonly returnFocus: Element | null;
  } | null>(null);
  const [focusedRegion, setFocusedRegion] = useState<CockpitRegion>("card");
  const lastUndo = useRef<{ readonly key: string; readonly undo: UndoOutcome } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRegionRef = useRef<HTMLDivElement>(null);
  const cardHandle = useRef<CockpitCardHandle>(null);
  const upNextRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLElement>(null);

  const now = queue.now.filter((item) => !acted.has(item.key));
  const keys = now.map((item) => item.key);
  const current =
    [...now, ...queue.snoozed].find((item) => item.key === currentKey) ?? now[0] ?? null;
  const next = now.filter((item) => item !== current);

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

  const focusCard = () => cardRegionRef.current?.focus();
  const focusRegion = (region: CockpitRegion) => {
    if (region === "card") focusCard();
    else if (region === "upNext") {
      const items = upNextRef.current ? rovingItems(upNextRef.current) : [];
      const currentRow = items.find((element) => element.dataset.cockpitItem === current?.key);
      (currentRow ?? items[0])?.focus();
    } else {
      overviewRef.current?.querySelector<HTMLElement>("[data-cockpit-entry]")?.focus();
    }
  };
  const regionAvailable = (region: CockpitRegion) => {
    const element = region === "upNext" ? upNextRef.current : overviewRef.current;
    return region === "card" || (element !== null && rovingItems(element).length > 0);
  };
  /** After an outcome, unless the user already moved to another area. */
  const refocusCard = () => {
    const region = regionOf(document.activeElement);
    if (region === null || region === "card") focusCard();
  };

  const select = (key: string) => {
    flushSync(() => setCurrentKey(key));
    focusCard();
  };
  const step = (direction: 1 | -1) => {
    const target = stepKey(keys, current?.key ?? null, direction);
    if (target !== null) select(target);
  };
  const finish = (item: CockpitItem, undo: UndoOutcome | null) => {
    flushSync(() => {
      setActed((previous) => new Set(previous).add(item.key));
      // An answer can land after the user stepped elsewhere; stay where they are then.
      setCurrentKey((previous) =>
        (previous ?? keys[0]) === item.key ? keyAfter(keys, item.key) : previous,
      );
    });
    lastUndo.current = undo === null ? null : { key: item.key, undo };
    refocusCard();
  };
  const undoLast = () => {
    const last = lastUndo.current;
    if (last === null) {
      toastManager.add({ type: "info", title: "Nothing to undo", timeout: 2_000 });
      return;
    }
    lastUndo.current = null;
    last.undo();
    flushSync(() => {
      setActed((previous) => {
        const nextActed = new Set(previous);
        nextActed.delete(last.key);
        return nextActed;
      });
      setCurrentKey(last.key);
    });
    focusCard();
  };
  const openThere = (item: CockpitItem, threadShell: EnvironmentThreadShell | null) => {
    if (item.threadId === null) return;
    useCockpitStore.setState({ open: false, returnFocus: null });
    const ref = scopeThreadRef(item.environmentId, item.threadId);
    const message = threadShell?.source.latestVisibleMessage;
    const quote = message?.role === "assistant" ? citationQuote(message.text) : null;
    if (message && quote !== null) {
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
      return;
    }
    void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
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
      case "cockpit.previous": {
        const direction = command === "cockpit.next" ? 1 : -1;
        const active = document.activeElement;
        const upNext = upNextRef.current;
        if (upNext !== null && regionOf(active) === "upNext") {
          const items = rovingItems(upNext);
          const at = items.indexOf(active as HTMLElement);
          const target = rovingTarget(at, items.length, direction === 1 ? "ArrowDown" : "ArrowUp");
          if (target !== null) items[target]?.focus();
          return true;
        }
        step(direction);
        return true;
      }
      case "cockpit.undo":
        undoLast();
        return true;
      case "cockpit.focusOverview":
        focusRegion("overview");
        return true;
      case "cockpit.help":
        useCockpitStore.setState({ helpOpen: !useCockpitStore.getState().helpOpen });
        return true;
      default:
        return cardHandle.current?.run(command) ?? false;
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
      focusRegion(
        cycleRegion(regionOf(target) ?? "card", event.shiftKey ? -1 : 1, regionAvailable),
      );
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
    const items = rovingItems(regionElement);
    const at = items.indexOf(target.closest<HTMLElement>("[data-roving]") ?? target);
    const goTo = rovingTarget(at, items.length, event.key);
    if (goTo === null) return;
    event.preventDefault();
    items[goTo]?.focus();
  };

  const hintKey = (...commands: ReadonlyArray<KeybindingCommand>) =>
    commands.flatMap((command) => keyLabel(command) ?? []).join(" ") || null;
  const hints: ReadonlyArray<readonly [string | null, string]> =
    focusedRegion === "upNext"
      ? [
          [[hintKey("cockpit.next", "cockpit.previous"), "↑↓"].filter(Boolean).join(" / "), "Move"],
          ["Enter", "Open"],
          ["Tab", "Next area"],
          ["Esc", "Back to the card"],
        ]
      : focusedRegion === "overview"
        ? [
            ["Enter", "Send"],
            ["Shift+Enter", "New line"],
            ["↑", "Quick prompts, when empty"],
            ["Tab", "Next area"],
            ["Esc", "Back to the card"],
          ]
        : [
            ...cardCommands.map(
              (command) => [hintKey(command), COMMAND_SHORT_LABELS[command]] as const,
            ),
            ...(optionCount > 0 ? [[`1–${Math.min(9, optionCount)}`, "Pick"] as const] : []),
            [hintKey("cockpit.previous", "cockpit.next"), "Back / Skip"],
            [hintKey("cockpit.focusOverview"), "Overview agent"],
            [hintKey("cockpit.help"), "All keys"],
            ["Esc", "Close"],
          ];

  return (
    <div
      ref={rootRef}
      className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const region = regionOf(event.target);
        if (region !== null && region !== focusedRegion) setFocusedRegion(region);
      }}
    >
      <header className="flex flex-col gap-2.5 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
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
        </div>
        {now.length > 0 ? (
          <div className="flex gap-0.5" aria-hidden>
            {now.map((item) => (
              <button
                key={item.key}
                type="button"
                tabIndex={-1}
                className={cn(
                  "h-2 min-w-1 flex-1 cursor-pointer rounded-sm opacity-70",
                  COCKPIT_KINDS[item.kind].barClassName,
                  item === current && "opacity-100 ring-2 ring-foreground ring-inset",
                )}
                onClick={() => select(item.key)}
              />
            ))}
          </div>
        ) : null}
      </header>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_340px] max-md:grid-cols-1">
        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div
            ref={cardRegionRef}
            tabIndex={-1}
            data-cockpit-region="card"
            className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {current !== null && card !== null ? (
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
                onSnooze={() => setSnoozing({ item: current, returnFocus: document.activeElement })}
                onUnsnooze={() => void clearTaskSnooze(current.environmentId, current.taskKey)}
                onOpenThere={() => openThere(current, shell)}
                onStep={step}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
                <p className="text-base font-medium text-foreground">Nothing is waiting on you.</p>
                <p>Snoozed tasks come back on their own.</p>
                <Button size="sm" variant="outline" onClick={() => setCockpitOpen(false)}>
                  Close cockpit
                </Button>
              </div>
            )}
          </div>
        </div>
        <aside className="grid min-h-0 grid-rows-[minmax(0,42%)_minmax(0,1fr)] border-s max-md:border-s-0 max-md:border-t">
          <CockpitUpNext
            regionRef={upNextRef}
            next={next}
            snoozed={queue.snoozed}
            snoozedExpanded={snoozedExpanded}
            nowMs={nowMs}
            onToggleSnoozed={() => setSnoozedExpanded((value) => !value)}
            onSelect={(item) => select(item.key)}
            onUnsnooze={(item) => void clearTaskSnooze(item.environmentId, item.taskKey)}
          />
          <CockpitOverview regionRef={overviewRef} />
        </aside>
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
  "cockpit.next": "Skip",
  "cockpit.previous": "Back",
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
