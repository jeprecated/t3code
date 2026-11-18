import { useEffect, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ClockIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { EnvironmentId, ThreadSnoozePresetKeybindingCommand } from "@t3tools/contracts";
import type { SnoozePresetSetting, TimestampFormat } from "@t3tools/contracts/settings";
import { parseTypedSnooze } from "@t3tools/client-runtime/state/thread-settled";

import { useClientSettings } from "../hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";
import { pickSnoozePreset, resolveSnoozePresets } from "./Sidebar.snooze";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

// Each command names a time, so it means the same one whatever the snooze menu holds:
// the defaults these names had before snooze options became settings.
const SNOOZE_PRESET_FOR_COMMAND: Record<ThreadSnoozePresetKeybindingCommand, SnoozePresetSetting> =
  {
    "thread.snooze.hour": { kind: "after", minutes: 60 },
    "thread.snooze.threeHours": { kind: "after", minutes: 180 },
    "thread.snooze.evening": { kind: "at", day: "today", time: "18:00" },
    "thread.snooze.tomorrow": { kind: "at", day: "tomorrow", time: "09:00" },
    "thread.snooze.nextWeek": { kind: "at", day: "monday", time: "09:00" },
  };

/** The preset a direct snooze command picks, skipping the picker. */
export function snoozePresetForCommand(command: string): SnoozePresetSetting | null {
  return Object.hasOwn(SNOOZE_PRESET_FOR_COMMAND, command)
    ? SNOOZE_PRESET_FOR_COMMAND[command as ThreadSnoozePresetKeybindingCommand]
    : null;
}

/** Nearest whole unit, unlike the sidebar's rounded-up countdown: "in 25 h", not "in 2d". */
function timeFromNow(snoozedUntil: string, now: Date, resolve: MessageResolver): string {
  const minutes = Math.max(1, Math.round((Date.parse(snoozedUntil) - now.getTime()) / 60_000));
  if (minutes < 90) return resolve(msg("in {count} min", { count: minutes }));
  if (minutes < 48 * 60) return resolve(msg("in {count} h", { count: Math.round(minutes / 60) }));
  return resolve(
    msg("{count, plural, one {in {count} day} other {in {count} days}}", {
      count: Math.round(minutes / (24 * 60)),
    }),
  );
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** "14:30", "tomorrow 9:00", "Fri 9:00", "Oct 20, 8:00": what a typed time means. */
function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
  resolve: MessageResolver,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = formatShortTimestamp(wake.toISOString(), timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return resolve(msg("Until {time}", { time }));
  if (dayDelta === 1) return resolve(msg("Until tomorrow {time}", { time }));
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return resolve(msg("Until {weekday} {time}", { weekday, time }));
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return resolve(msg("Until {date}, {time}", { date, time }));
}

type SnoozeChoice = { readonly snoozedUntil: string };
type PickerResult = SnoozeChoice | "custom" | null;
type Request = {
  readonly resolve: (result: PickerResult) => void;
  /** Snooze options are each environment's own. */
  readonly environmentId: EnvironmentId;
  /** Focus returns here when the picker closes, like a menu opened from it. */
  readonly returnFocus: Element | null;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Keyboard snooze picker: arrows or Tab turn a wheel of the shared presets,
 * and any typing switches to free text ("5d", "tomorrow 14"). Custom… hands
 * over to the thread menu's dialog. Resolves null on Esc.
 */
export async function requestSnoozeTime(
  environmentId: EnvironmentId,
): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  const returnFocus = document.activeElement;
  const result = await new Promise<PickerResult>((resolve) =>
    useRequest.setState({ request: { resolve, returnFocus, environmentId } }),
  );
  return result === "custom" ? requestCustomSnooze() : result;
}

function finish(result: PickerResult) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(result);
}

export function SnoozePromptHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an unmounted host resolves its pending request, so the shortcut's await never hangs
  useEffect(() => () => finish(null), []);
  return (
    <CommandDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      {request ? (
        <SnoozePrompt returnFocus={request.returnFocus} environmentId={request.environmentId} />
      ) : null}
    </CommandDialog>
  );
}

const CUSTOM_CHOICE = {
  id: "custom",
  label: msg("Custom…", { $context: "custom snooze time" }),
  whenLabel: msg("Pick a time"),
} as const;

// The typed-time parser reads English words, so its examples stay English.
const TYPED_SNOOZE_EXAMPLES = "5d, tomorrow 14, fri 9";
const TYPED_SNOOZE_HINT = "5d, 3h, tomorrow 14, mon 9";

function SnoozePrompt(props: {
  readonly returnFocus: Element | null;
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve once per opening so the wheel does not shift while it is open.
  const [presets] = useState(() =>
    resolveSnoozePresets(new Date(), timestampFormat, props.environmentId, messages),
  );
  const choices = [
    ...presets,
    {
      id: CUSTOM_CHOICE.id,
      label: messages(CUSTOM_CHOICE.label),
      whenLabel: messages(CUSTOM_CHOICE.whenLabel),
    },
  ];
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  // Read when the text changes, not during render, so the parse stays pure.
  const [now, setNow] = useState(() => new Date());
  const typing = text.trim() !== "";
  const typed = typing ? parseTypedSnooze(text, now) : null;
  const at = (offset: number) => choices[(index + offset + choices.length) % choices.length]!;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!typing) {
        const choice = at(0);
        if (choice.id === "custom") {
          finish("custom");
          return;
        }
        // As the thread menu picks: a duration starts now, a set time keeps its shown wake.
        const picked = pickSnoozePreset(
          presets,
          choice.id,
          timestampFormat,
          props.environmentId,
          messages,
        );
        finish(picked ? { snoozedUntil: picked.snoozedUntil } : null);
      } else if (typed?._tag === "Wake") finish({ snoozedUntil: typed.snoozedUntil });
      return;
    }
    // Tab never leaves the field; it only turns the wheel.
    const step =
      event.key === "Tab"
        ? event.shiftKey
          ? -1
          : 1
        : !typing && event.key === "ArrowRight"
          ? 1
          : !typing && event.key === "ArrowLeft"
            ? -1
            : 0;
    if (event.key !== "Tab" && step === 0) return;
    event.preventDefault();
    if (!typing) setIndex((current) => (current + step + choices.length) % choices.length);
  };

  return (
    <CommandDialogPopup
      aria-label={gt("Snooze thread")}
      className="max-w-md overflow-hidden"
      finalFocus={() => {
        if (props.returnFocus instanceof HTMLElement && props.returnFocus.isConnected) {
          props.returnFocus.focus();
        }
        return false;
      }}
    >
      <label className="flex h-11 items-center gap-2 border-b px-3">
        <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          aria-describedby="snooze-prompt-choice"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="snooze-prompt"
          placeholder={gt("Snooze until… {examples}", { examples: TYPED_SNOOZE_EXAMPLES })}
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setNow(new Date());
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      <div id="snooze-prompt-choice" aria-live="polite" className="flex h-16 items-center px-3">
        {!typing ? (
          <div className="grid w-full grid-cols-3 gap-1.5 text-center">
            {[-1, 0, 1].map((offset) => {
              const choice = at(offset);
              return (
                <div
                  key={offset}
                  aria-hidden={offset !== 0}
                  className={cn(
                    "min-w-0 rounded-lg px-1 py-1.5",
                    offset === 0
                      ? "bg-foreground/[0.08] text-foreground ring-1 ring-foreground/10"
                      : "text-muted-foreground opacity-70",
                  )}
                >
                  <div className="truncate text-sm">{choice.label}</div>
                  <div className="truncate text-muted-foreground text-xs">{choice.whenLabel}</div>
                </div>
              );
            })}
          </div>
        ) : typed?._tag === "Wake" ? (
          <div className="flex w-full items-center gap-2.5 text-sm">
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
            <span className="min-w-0 truncate">
              {snoozeWakeDescription(typed.snoozedUntil, now, timestampFormat, messages)}
            </span>
            <span className="ms-auto shrink-0 text-muted-foreground text-xs">
              {timeFromNow(typed.snoozedUntil, now, messages)}
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-destructive-foreground">
              {typed?._tag === "Past" ? gt("That time has passed.") : gt("Not sure when that is.")}
            </span>{" "}
            {gt("Try {examples}.", { examples: TYPED_SNOOZE_HINT })}
          </p>
        )}
      </div>
      <CommandFooter>
        {typing ? (
          <KbdGroup>
            <Kbd>Backspace</Kbd>
            <span>
              <T>Presets</T>
            </span>
          </KbdGroup>
        ) : (
          <KbdGroup>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <Kbd>Tab</Kbd>
            <span>
              <T>Choose</T>
            </span>
          </KbdGroup>
        )}
        {!typing || typed?._tag === "Wake" ? (
          <KbdGroup>
            <Kbd>Enter</Kbd>
            <span>
              <T>Snooze</T>
            </span>
          </KbdGroup>
        ) : null}
        <KbdGroup>
          <Kbd>Esc</Kbd>
          <span>
            <T>Close</T>
          </span>
        </KbdGroup>
      </CommandFooter>
    </CommandDialogPopup>
  );
}
