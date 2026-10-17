import { useEffect, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ClockIcon } from "lucide-react";
import type { ThreadSnoozePresetKeybindingCommand } from "@t3tools/contracts";
import {
  parseTypedSnooze,
  type SnoozePresetId,
} from "@t3tools/client-runtime/state/thread-settled";

import { useClientSettings } from "../hooks/useSettings";
import { cn } from "~/lib/utils";
import { resolveSnoozePresets, snoozeWakeDescription } from "./Sidebar.snooze";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

const SNOOZE_PRESET_FOR_COMMAND: Record<ThreadSnoozePresetKeybindingCommand, SnoozePresetId> = {
  "thread.snooze.hour": "hour",
  "thread.snooze.threeHours": "three-hours",
  "thread.snooze.evening": "evening",
  "thread.snooze.tomorrow": "tomorrow",
  "thread.snooze.nextWeek": "next-week",
};

/** The preset a direct snooze command picks, skipping the prompt. */
export function snoozePresetForCommand(command: string): SnoozePresetId | null {
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

type SnoozeChoice = { readonly snoozedUntil: string };
type Request = {
  readonly resolve: (choice: SnoozeChoice | null) => void;
  /** Focus returns here when the prompt closes, like a menu opened from it. */
  readonly returnFocus: Element | null;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Keyboard snooze prompt: Tab turns a wheel of the shared presets, and any
 * typing switches to free text ("5d", "tomorrow 14"). Resolves null on Esc.
 */
export function requestSnoozeTime(): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  const returnFocus = document.activeElement;
  return new Promise((resolve) => useRequest.setState({ request: { resolve, returnFocus } }));
}

function finish(choice: SnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function SnoozePromptHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return (
    <CommandDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      {request ? <SnoozePrompt returnFocus={request.returnFocus} /> : null}
    </CommandDialog>
  );
}

function SnoozePrompt(props: { readonly returnFocus: Element | null }) {
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve once per opening so the wheel does not shift while it is open.
  const [presets] = useState(() => resolveSnoozePresets(new Date(), timestampFormat));
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const now = new Date();
  const typing = text.trim() !== "";
  const typed = typing ? parseTypedSnooze(text, now) : null;
  const at = (offset: number) => presets[(index + offset + presets.length) % presets.length]!;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!typing) finish({ snoozedUntil: at(0).snoozedUntil });
      else if (typed?._tag === "Wake") finish({ snoozedUntil: typed.snoozedUntil });
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
    if (!typing) setIndex((current) => (current + step + presets.length) % presets.length);
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
          data-testid="snooze-prompt-input"
          placeholder="Snooze until… 5d, tomorrow 14, fri 9"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div id="snooze-prompt-choice" aria-live="polite" className="flex h-16 items-center px-3">
        {!typing ? (
          <div className="grid w-full grid-cols-3 gap-1.5 text-center">
            {[-1, 0, 1].map((offset) => {
              const preset = at(offset);
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
                  <div className="truncate text-sm">{preset.label}</div>
                  <div className="truncate text-muted-foreground text-xs">{preset.whenLabel}</div>
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
              Until {snoozeWakeDescription(typed.snoozedUntil, now, timestampFormat)}
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
            Try 5d, 3h, tomorrow 14, mon 9.
          </p>
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
              <Kbd>Tab</Kbd> next <Kbd>⇧Tab</Kbd> back
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
