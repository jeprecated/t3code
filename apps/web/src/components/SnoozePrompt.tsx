import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ClockIcon } from "lucide-react";

import { useClientSettings } from "../hooks/useSettings";
import { cn } from "~/lib/utils";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { resolveSnoozePresets } from "./Sidebar.snooze";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type SnoozeChoice = { readonly snoozedUntil: string };
type PickerResult = SnoozeChoice | "custom" | null;
type Request = {
  readonly resolve: (result: PickerResult) => void;
  /** Focus returns here when the picker closes, like a menu opened from it. */
  readonly returnFocus: Element | null;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Keyboard snooze picker: arrows or Tab turn a wheel of the shared presets.
 * Custom… hands over to the thread menu's dialog. Resolves null on Esc.
 */
export async function requestSnoozeTime(): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  const returnFocus = document.activeElement;
  const result = await new Promise<PickerResult>((resolve) =>
    useRequest.setState({ request: { resolve, returnFocus } }),
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

const CUSTOM_CHOICE = { id: "custom", label: "Custom…", whenLabel: "Pick a time" } as const;

function SnoozePrompt(props: { readonly returnFocus: Element | null }) {
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve once per opening so the wheel does not shift while it is open.
  const [choices] = useState(() => [
    ...resolveSnoozePresets(new Date(), timestampFormat),
    CUSTOM_CHOICE,
  ]);
  const [index, setIndex] = useState(0);
  const listboxRef = useRef<HTMLDivElement>(null);
  const at = (offset: number) => choices[(index + offset + choices.length) % choices.length]!;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = at(0);
      finish(choice.id === "custom" ? "custom" : { snoozedUntil: choice.snoozedUntil });
      return;
    }
    const step =
      event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)
        ? 1
        : event.key === "ArrowLeft" || event.key === "Tab"
          ? -1
          : 0;
    if (step === 0) return;
    // Tab never leaves the picker; it only turns the wheel.
    event.preventDefault();
    setIndex((current) => (current + step + choices.length) % choices.length);
  };

  return (
    <CommandDialogPopup
      aria-label="Snooze thread"
      className="max-w-md overflow-hidden"
      initialFocus={listboxRef}
      finalFocus={() => {
        if (props.returnFocus instanceof HTMLElement && props.returnFocus.isConnected) {
          props.returnFocus.focus();
        }
        return false;
      }}
    >
      <div className="flex h-11 items-center gap-2 border-b px-3 text-muted-foreground text-sm">
        <ClockIcon aria-hidden className="size-4 shrink-0" />
        Snooze until…
      </div>
      <div
        ref={listboxRef}
        role="listbox"
        aria-label="Snooze until"
        aria-activedescendant="snooze-prompt-choice"
        tabIndex={0}
        data-testid="snooze-prompt"
        className="flex h-16 items-center px-3 outline-none"
        onKeyDown={onKeyDown}
      >
        <div className="grid w-full grid-cols-3 gap-1.5 text-center">
          {[-1, 0, 1].map((offset) => {
            const choice = at(offset);
            return (
              <div
                key={offset}
                id={offset === 0 ? "snooze-prompt-choice" : undefined}
                role={offset === 0 ? "option" : undefined}
                aria-selected={offset === 0 ? true : undefined}
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
      </div>
      <CommandFooter>
        <KbdGroup>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> or <Kbd>Tab</Kbd> choose
        </KbdGroup>
        <KbdGroup>
          <Kbd>↵</Kbd> snooze <Kbd>Esc</Kbd>
        </KbdGroup>
      </CommandFooter>
    </CommandDialogPopup>
  );
}
