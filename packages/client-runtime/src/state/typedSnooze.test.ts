// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze text.
import { describe, expect, it } from "vite-plus/test";
import { parseTypedSnooze } from "./threadSettled.ts";

// Thursday, 14:20 local time.
const now = new Date(2026, 9, 15, 14, 20);

function wakeAt(text: string): Date | string {
  const result = parseTypedSnooze(text, now);
  return result._tag === "Wake" ? new Date(result.snoozedUntil) : result._tag;
}

describe("typed snooze", () => {
  it.each([
    ["30m", new Date(2026, 9, 15, 14, 50)],
    ["2h", new Date(2026, 9, 15, 16, 20)],
    ["in 3h", new Date(2026, 9, 15, 17, 20)],
    ["1h30m", new Date(2026, 9, 15, 15, 50)],
    ["2 hours", new Date(2026, 9, 15, 16, 20)],
    ["1.5h", new Date(2026, 9, 15, 15, 50)],
    ["5d", new Date(now.getTime() + 5 * 24 * 3_600_000)],
    ["1w", new Date(now.getTime() + 7 * 24 * 3_600_000)],
  ])("reads the duration %s from now", (text, expected) => {
    expect(wakeAt(text)).toEqual(expected);
  });

  it.each([
    ["16", new Date(2026, 9, 15, 16, 0)],
    ["16:45", new Date(2026, 9, 15, 16, 45)],
    ["4pm", new Date(2026, 9, 15, 16, 0)],
    ["9:15am", new Date(2026, 9, 16, 9, 15)],
    ["14", new Date(2026, 9, 16, 14, 0)],
    ["12am", new Date(2026, 9, 16, 0, 0)],
  ])("reads the time %s as today, or tomorrow once it has passed", (text, expected) => {
    expect(wakeAt(text)).toEqual(expected);
  });

  it.each([
    ["tomorrow", new Date(2026, 9, 16, 9, 0)],
    ["Tomorrow 14", new Date(2026, 9, 16, 14, 0)],
    ["tmr 9:30am", new Date(2026, 9, 16, 9, 30)],
    ["fri", new Date(2026, 9, 16, 9, 0)],
    ["mon 10:30", new Date(2026, 9, 19, 10, 30)],
    ["thursday 17", new Date(2026, 9, 22, 17, 0)],
    ["today 18", new Date(2026, 9, 15, 18, 0)],
    ["evening", new Date(2026, 9, 15, 18, 0)],
    ["next week", new Date(2026, 9, 19, 9, 0)],
    ["oct 20", new Date(2026, 9, 20, 9, 0)],
    ["20 oct 8am", new Date(2026, 9, 20, 8, 0)],
    ["october 15 16", new Date(2026, 9, 15, 16, 0)],
    ["jan 3", new Date(2027, 0, 3, 9, 0)],
  ])("reads the day %s", (text, expected) => {
    expect(wakeAt(text)).toEqual(expected);
  });

  it.each(["today 9", "today", "oct 15 8am"])("reports %s as already past", (text) => {
    expect(wakeAt(text)).toBe("Past");
  });

  it.each(["", "later-ish", "0m", "5x", "25", "13pm", "fri noonish", "feb 30", "tomorrow 9:75"])(
    "does not understand %s",
    (text) => {
      expect(wakeAt(text)).toBe("Unknown");
    },
  );

  it("passes evening once it is over", () => {
    expect(parseTypedSnooze("evening", new Date(2026, 9, 15, 19, 0))).toEqual({ _tag: "Past" });
  });
});
