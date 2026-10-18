// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";

import type { PendingSubagentRequest } from "./models.ts";

interface SettlementRunLike {
  readonly turnId?: unknown;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function hasQueuedTurnStart(
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
  if (shell.latestUserMessageAt == null) return false;
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
}

export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  if (shell.pendingSubagentRequest != null) return true;
  const runtime = shell.runtime ?? shell.session ?? null;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (
    (runtime?.status === "error" || runtime?.status === "failed") &&
    (shell.snoozedAt == null ||
      (runtime.updatedAt != null && Date.parse(runtime.updatedAt) > Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  if (
    shell.snoozedAt != null &&
    (latestRun?.state === "completed" || latestRun?.status === "completed") &&
    latestRun.completedAt != null &&
    Date.parse(latestRun.completedAt) > Date.parse(shell.snoozedAt)
  ) {
    return true;
  }
  return false;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.pendingSubagentRequest != null) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
    const runtime = shell.runtime ?? shell.session ?? null;
    if (
      shell.snoozedAt != null &&
      (latestRun?.state === "completed" || latestRun?.status === "completed") &&
      latestRun.completedAt != null &&
      Date.parse(latestRun.completedAt) > Date.parse(shell.snoozedAt)
    ) {
      return latestRun.completedAt;
    }
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number, minute = 0): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setHours(hour, minute, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

function nextMondayMorning(now: Date): Date {
  return snoozeAtHour(addSnoozeDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR);
}

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + HOUR_MS));
  const inThreeHours = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + 3 * HOUR_MS));
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const nextWeek = nextMondayMorning(now);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }

  return presets;
}

export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export type TypedSnooze =
  | { readonly _tag: "Wake"; readonly snoozedUntil: string }
  | { readonly _tag: "Past" }
  | { readonly _tag: "Unknown" };

const SNOOZE_UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  wk: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
};

const SNOOZE_WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const SNOOZE_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/** "14", "14:30", "2pm", "9:15am" as [hour, minute] on a 24-hour clock. */
function parseSnoozeTimeOfDay(text: string): readonly [number, number] | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (match[3] !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

/** "oct 20" or "20 oct", optionally followed by a time. The next such date, this year or next. */
function parseSnoozeCalendarDate(
  text: string,
  now: Date,
): { readonly day: Date; readonly rest: string } | null {
  const match =
    /^([a-z]{3})[a-z]* (\d{1,2})(?: (.*))?$/.exec(text) ??
    /^(\d{1,2}) ([a-z]{3})[a-z]*(?: (.*))?$/.exec(text);
  if (!match) return null;
  const [monthText, dayText] = /^\d/.test(match[1]!)
    ? [match[2]!, match[1]!]
    : [match[1]!, match[2]!];
  const month = SNOOZE_MONTHS.indexOf(monthText as (typeof SNOOZE_MONTHS)[number]);
  const dayOfMonth = Number(dayText);
  if (month === -1) return null;
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const day = new Date(year, month, dayOfMonth);
    // Reject rolled-over dates such as "feb 30".
    if (day.getMonth() !== month) return null;
    if (snoozeAtHour(day, 24).getTime() > now.getTime()) return { day, rest: match[3] ?? "" };
  }
  return null;
}

/**
 * Free-text snooze time for keyboard entry: durations ("30m", "5d",
 * "1h30m", "in 3h"), times ("14", "2pm", today or else tomorrow), days with
 * an optional time ("tomorrow 14", "fri", "oct 20 8am"; 9:00 by default),
 * "evening", and "next week". Distinguishes text that names a past time
 * from text it does not understand so the prompt can say which.
 */
export function parseTypedSnooze(input: string, now: Date): TypedSnooze {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/^in /, "");
  const wake = (date: Date): TypedSnooze =>
    !Number.isFinite(date.getTime())
      ? { _tag: "Unknown" }
      : date.getTime() > now.getTime()
        ? { _tag: "Wake", snoozedUntil: date.toISOString() }
        : { _tag: "Past" };
  if (text === "") return { _tag: "Unknown" };

  const durationParts = [...text.matchAll(/(\d+(?:\.\d+)?) ?([a-z]+)/g)];
  if (
    durationParts.length > 0 &&
    durationParts
      .map((part) => part[0])
      .join("")
      .replaceAll(" ", "") === text.replaceAll(" ", "") &&
    durationParts.every((part) => SNOOZE_UNIT_MS[part[2]!] !== undefined)
  ) {
    const elapsed = durationParts.reduce(
      (total, part) => total + Number(part[1]) * SNOOZE_UNIT_MS[part[2]!]!,
      0,
    );
    return elapsed > 0 ? wake(new Date(now.getTime() + elapsed)) : { _tag: "Unknown" };
  }

  if (text === "next week") return wake(nextMondayMorning(now));
  if (text === "evening" || text === "tonight") return wake(snoozeAtHour(now, EVENING_HOUR));

  const [first = "", ...restWords] = text.split(" ");
  const afterFirst = restWords.join(" ");
  let dated: { readonly day: Date; readonly rest: string } | null = null;
  if (first === "tomorrow" || first === "tom" || first === "tmr" || first === "tmrw") {
    dated = { day: addSnoozeDays(now, 1), rest: afterFirst };
  } else if (first === "today") {
    dated = { day: now, rest: afterFirst };
  } else if (SNOOZE_WEEKDAYS[first] !== undefined) {
    const daysAhead = (SNOOZE_WEEKDAYS[first] - now.getDay() + 7) % 7 || 7;
    dated = { day: addSnoozeDays(now, daysAhead), rest: afterFirst };
  } else {
    dated = parseSnoozeCalendarDate(text, now);
  }
  if (dated) {
    if (dated.rest === "") return wake(snoozeAtHour(dated.day, MORNING_HOUR));
    const time = parseSnoozeTimeOfDay(dated.rest);
    return time ? wake(snoozeAtHour(dated.day, time[0], time[1])) : { _tag: "Unknown" };
  }

  const time = parseSnoozeTimeOfDay(text);
  if (!time) return { _tag: "Unknown" };
  const today = snoozeAtHour(now, time[0], time[1]);
  return wake(today.getTime() > now.getTime() ? today : addSnoozeDays(today, 1));
}
