import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ClockIcon } from "lucide-react";
import type { EnvironmentId, ThreadSnoozePresetKeybindingCommand } from "@t3tools/contracts";
import type { SnoozePresetSetting, TimestampFormat } from "@t3tools/contracts/settings";
import { parseTypedSnooze } from "@t3tools/client-runtime/state/thread-settled";

import { useClientSettings } from "../hooks/useSettings";
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
function timeFromNow(snoozedUntil: string, now: Date): string {
  const minutes = Math.max(1, Math.round((Date.parse(snoozedUntil) - now.getTime()) / 60_000));
  if (minutes < 90) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / (24 * 60))} days`;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** "14:30", "tomorrow 9:00", "Fri 9:00", "Oct 20, 8:00": what a typed time means. */
function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = formatShortTimestamp(wake.toISOString(), timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

type SnoozeChoice = { readonly snoozedUntil: string };
type PickerResult = SnoozeChoice | "custom" | null;
type Request = {
  readonly resolve: (result: PickerResult) => void;
  /** Snooze options are each environment's own. */
  readonly environmentId: EnvironmentId;
  /** Focus returns here when the picker closes, like a menu opened from it. */
  readonly returnFocus: Element | null;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Keyboard snooze picker: arrows or Tab turn a wheel of the shared presets,
 * and any typing switches to free text ("5d", "tomorrow 14"). Custom… hands
 * over to the thread menu's dialog. Resolves null on Esc. `presets` replaces the
 * environment's with a numbered list, as for one task.
 */
export async function requestSnoozeTime(
  environmentId: EnvironmentId,
  options: { readonly presets?: ReadonlyArray<SnoozePresetSetting> } = {},
): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  const returnFocus = document.activeElement;
  const result = await new Promise<PickerResult>((resolve) =>
    useRequest.setState({
      request: { resolve, returnFocus, environmentId, presets: options.presets },
    }),
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
        <SnoozePrompt
          returnFocus={request.returnFocus}
          environmentId={request.environmentId}
          presets={request.presets}
          onFinish={finish}
        />
      ) : null}
    </CommandDialog>
  );
}

const CUSTOM_CHOICE = { id: "custom", label: "Custom…", whenLabel: "Pick a time" } as const;

/** Render inside a `CommandDialog`; a dialog that opens it nests it, so focus stays trapped. */
export function SnoozePrompt(props: {
  readonly returnFocus: Element | null;
  readonly environmentId: EnvironmentId;
  readonly presets?: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly onFinish: (result: PickerResult) => void;
}) {
  return props.presets === undefined ? (
    <SnoozeWheel {...props} />
  ) : (
    <NumberedSnoozePrompt {...props} presets={props.presets} />
  );
}

function SnoozeWheel(props: {
  readonly returnFocus: Element | null;
  readonly environmentId: EnvironmentId;
  readonly onFinish: (result: PickerResult) => void;
}) {
  const finish = props.onFinish;
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve once per opening so the wheel does not shift while it is open.
  const [presets] = useState(() =>
    resolveSnoozePresets(new Date(), timestampFormat, props.environmentId),
  );
  const choices = [...presets, CUSTOM_CHOICE];
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
        const picked = pickSnoozePreset(presets, choice.id, timestampFormat, props.environmentId);
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
      aria-label="Snooze thread"
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
          placeholder="Snooze until… 5d, tomorrow 14, fri 9"
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
        ) : (
          <TypedSnooze typed={typed} now={now} timestampFormat={timestampFormat} />
        )}
      </div>
      <CommandFooter>
        <KbdGroup>
          {typing ? (
            <>
              <Kbd>⌫</Kbd> presets
            </>
          ) : (
            <>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> or <Kbd>Tab</Kbd> choose
            </>
          )}
        </KbdGroup>
        <KbdGroup>
          {(!typing || typed?._tag === "Wake") && (
            <>
              <Kbd>↵</Kbd> snooze
            </>
          )}
          <Kbd>Esc</Kbd>
        </KbdGroup>
      </CommandFooter>
    </CommandDialogPopup>
  );
}

function TypedSnooze(props: {
  readonly typed: ReturnType<typeof parseTypedSnooze> | null;
  readonly now: Date;
  readonly timestampFormat: TimestampFormat;
}) {
  const { typed, now } = props;
  return typed?._tag === "Wake" ? (
    <div className="flex w-full items-center gap-2.5 text-sm">
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="min-w-0 truncate">
        Until {snoozeWakeDescription(typed.snoozedUntil, now, props.timestampFormat)}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground text-xs">
        {timeFromNow(typed.snoozedUntil, now)}
      </span>
    </div>
  ) : (
    <p className="text-muted-foreground text-sm">
      <span className="font-medium text-destructive-foreground">
        {typed?._tag === "Past" ? "That time has passed." : "Not sure when that is."}
      </span>{" "}
      Try 30m, 14:30, tomorrow 9, mon 9.
    </p>
  );
}

/**
 * Number keys pick a preset at once. Typing a letter, or Tab, goes to the field, where a
 * typed time ("30m", "14:30", "tomorrow 9") snoozes on Enter.
 */
function NumberedSnoozePrompt(props: {
  readonly returnFocus: Element | null;
  readonly environmentId: EnvironmentId;
  readonly presets: ReadonlyArray<SnoozePresetSetting>;
  readonly onFinish: (result: PickerResult) => void;
}) {
  const finish = props.onFinish;
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const [shown] = useState(() =>
    resolveSnoozePresets(new Date(), timestampFormat, props.environmentId, props.presets),
  );
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => new Date());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typing = text.trim() !== "";
  const typed = typing ? parseTypedSnooze(text, now) : null;

  const pick = (presetIndex: number) => {
    const choice = shown[presetIndex];
    if (choice === undefined) return;
    const picked = pickSnoozePreset(
      shown,
      choice.id,
      timestampFormat,
      props.environmentId,
      props.presets,
    );
    finish(picked ? { snoozedUntil: picked.snoozedUntil } : null);
  };
  const type = (value: string) => {
    setText(value);
    setNow(new Date());
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const step =
      event.key === "ArrowDown" || event.key === "j"
        ? 1
        : event.key === "ArrowUp" || event.key === "k"
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      setIndex((current) => Math.max(0, Math.min(shown.length - 1, current + step)));
    } else if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      pick(Number(event.key) - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(index);
    } else if (event.key === "Tab" || (event.key.length === 1 && event.key !== " ")) {
      event.preventDefault();
      if (event.key !== "Tab") type(event.key);
      inputRef.current?.focus();
    }
  };
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (typed?._tag === "Wake") finish({ snoozedUntil: typed.snoozedUntil });
    } else if (event.key === "Tab" || (event.key === "ArrowDown" && !typing)) {
      event.preventDefault();
      listRef.current?.focus();
    }
  };

  return (
    <CommandDialogPopup
      aria-label="Snooze"
      className="max-w-sm overflow-hidden"
      initialFocus={listRef}
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
          ref={inputRef}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          data-testid="snooze-prompt"
          placeholder="Snooze until… 30m, 14:30, tomorrow 9"
          spellCheck={false}
          value={text}
          onChange={(event) => type(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
      </label>
      {typing ? (
        <div aria-live="polite" className="flex h-11 items-center px-3">
          <TypedSnooze typed={typed} now={now} timestampFormat={timestampFormat} />
        </div>
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label="Snooze presets"
        aria-activedescendant={`snooze-preset-${index}`}
        className="flex flex-col p-1 outline-none"
        onKeyDown={onListKeyDown}
      >
        {shown.map((preset, presetIndex) => (
          <div
            key={preset.id}
            id={`snooze-preset-${presetIndex}`}
            role="option"
            aria-selected={presetIndex === index}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              presetIndex === index && "bg-foreground/[0.08]",
            )}
            onMouseMove={() => setIndex(presetIndex)}
            onClick={() => pick(presetIndex)}
          >
            {presetIndex < 9 ? <Kbd>{presetIndex + 1}</Kbd> : null}
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            <span className="shrink-0 text-muted-foreground text-xs">{preset.whenLabel}</span>
          </div>
        ))}
      </div>
      <CommandFooter>
        <KbdGroup>
          <Kbd>1</Kbd>–<Kbd>{Math.min(9, shown.length)}</Kbd> pick
        </KbdGroup>
        <KbdGroup>
          <Kbd>Tab</Kbd> type a time
        </KbdGroup>
        <KbdGroup>
          <Kbd>Esc</Kbd>
        </KbdGroup>
      </CommandFooter>
    </CommandDialogPopup>
  );
}
