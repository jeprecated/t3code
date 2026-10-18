// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from "@t3tools/contracts/settings";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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
 * Failed starts and stale shells from older servers can leave user messages unadopted.
 * Bound the pending window so those threads can eventually settle.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

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
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingUserInputAt?: string | null;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly pendingGuestMessageCount?: number;
}

function pendingQuestionAt(shell: ThreadSnoozeShell): string | null {
  const request = shell.source?.pendingRuntimeRequest;
  return (
    shell.pendingUserInputAt ??
    (request?.kind === "user_input" ? DateTime.formatIso(request.createdAt) : null)
  );
}

/**
 * Only a request for the user or a fresh failure ends a snooze early. Completed runs never do:
 * a snoozed long-running thread keeps waking itself for background work and stays hidden
 * until its timer.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  const request = shell.source?.pendingRuntimeRequest;
  if (shell.hasPendingApprovals || (request != null && request.kind !== "user_input")) return true;
  const questionAt = pendingQuestionAt(shell);
  // Snoozing an existing question means "ask me later". Only a new question
  // wakes it early; missing or invalid timestamps keep the request visible.
  if (
    (shell.hasPendingUserInput || request?.kind === "user_input") &&
    (shell.snoozedAt == null ||
      questionAt == null ||
      !(Date.parse(questionAt) <= Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  if (shell.pendingSubagentRequest != null) return true;
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return true;
  const failedAt = failureEdgeAt(shell);
  return (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  );
}

// V2 runtime.updatedAt includes metadata writes, not just failures.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed") {
    return latestRun.completedAt ?? null;
  }
  return runtime.updatedAt ?? null;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
    | "source"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals) return false;
  const request = shell.source?.pendingRuntimeRequest;
  if (request != null && request.kind !== "user_input") return false;
  if (shell.pendingSubagentRequest != null) return false;
  // A waiting guest message would wake it at once.
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return false;
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
    const failedAt = failureEdgeAt(shell);
    const questionAt = pendingQuestionAt(shell);
    const freshFailure =
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt));
    const freshQuestion =
      questionAt != null &&
      shell.snoozedAt != null &&
      Date.parse(questionAt) > Date.parse(shell.snoozedAt);
    if (freshFailure && (!freshQuestion || Date.parse(failedAt) >= Date.parse(questionAt))) {
      return failedAt;
    }
    if (freshQuestion) return questionAt;
    const runtime = shell.runtime ?? shell.session ?? null;
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

const HOUR_MS = 60 * 60 * 1_000;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

export interface SnoozePresetOptions {
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

/** "In 3 hours", "In 90 minutes", "In 2 days": the largest unit that divides evenly. */
function snoozeDurationLabel(minutes: number, resolve: MFunctionType): string {
  if (minutes % (24 * 60) === 0) {
    return resolve(
      msg("{count, plural, one {In {count} day} other {In {count} days}}", {
        count: minutes / (24 * 60),
      }),
    );
  }
  if (minutes % 60 === 0) {
    return resolve(
      msg("{count, plural, one {In {count} hour} other {In {count} hours}}", {
        count: minutes / 60,
      }),
    );
  }
  return resolve(
    msg("{count, plural, one {In {count} minute} other {In {count} minutes}}", { count: minutes }),
  );
}

const WEEKDAY_LABELS = {
  sunday: msg("Sunday"),
  monday: msg("Monday"),
  tuesday: msg("Tuesday"),
  wednesday: msg("Wednesday"),
  thursday: msg("Thursday"),
  friday: msg("Friday"),
  saturday: msg("Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

const NEXT_WEEKDAY_LABELS = {
  sunday: msg("Next Sunday"),
  monday: msg("Next Monday"),
  tuesday: msg("Next Tuesday"),
  wednesday: msg("Next Wednesday"),
  thursday: msg("Next Thursday"),
  friday: msg("Next Friday"),
  saturday: msg("Next Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(
  setting: SnoozePresetSetting,
  daysAhead: number,
  resolve: MFunctionType,
): string {
  if (setting.kind === "after") return snoozeDurationLabel(setting.minutes, resolve);
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12
      ? resolve(msg("This morning"))
      : hour < 17
        ? resolve(msg("This afternoon"))
        : resolve(msg("This evening"));
  }
  if (daysAhead === 1) return resolve(msg("Tomorrow"));
  if (setting.day === "monday") return resolve(msg("Next week"));
  if (setting.day === "today" || setting.day === "tomorrow") return "";
  return resolve(daysAhead === 7 ? NEXT_WEEKDAY_LABELS[setting.day] : WEEKDAY_LABELS[setting.day]);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
  resolve: MFunctionType = mFallback,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead, resolve);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && !(daysAhead > 1 && setting.day === "monday");
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  options: SnoozePresetOptions = {},
  resolve: MFunctionType = mFallback,
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return (
    (options.presets ?? DEFAULT_SNOOZE_PRESETS)
      .flatMap((setting) => resolveSnoozePreset(setting, now, options.formatTime, resolve) ?? [])
      // flatMap returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => wakeMinute(a) - wakeMinute(b))
      .filter((preset) => {
        if (seen.has(wakeMinute(preset))) return false;
        seen.add(wakeMinute(preset));
        return true;
      })
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly now: Date;
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
  readonly resolve?: MFunctionType;
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > input.now.getTime() ? original : undefined;
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (
    (setting && resolveSnoozePreset(setting, input.now, input.formatTime, input.resolve)) ?? ahead
  );
}

export function snoozeWakeLabel(
  snoozedUntil: string,
  options: { readonly now: string },
  resolve: MFunctionType = mFallback,
): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  const now = () => resolve(msg("now", { $context: "a snoozed thread wakes now" }));
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return now();
  if (wakeMs <= nowMs) return now();
  // Count clock minutes: callers pass a minute-floored or live `now`, and durations keep seconds.
  const minutes = Math.max(1, Math.floor(wakeMs / 60_000) - Math.floor(nowMs / 60_000));
  if (minutes < 60) return resolve(msg("{minutes}m", { minutes: String(minutes) }));
  if (minutes < 24 * 60) {
    return resolve(msg("{hours}h", { hours: String(Math.ceil(minutes / 60)) }));
  }
  return resolve(msg("{days}d", { days: String(Math.ceil(minutes / (24 * 60))) }));
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

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}

/**
 * Whether the latest run failed after the user last saw the thread. Only the run dates the
 * failure, since the shell's updatedAt also moves on renames. A failed run without a
 * completion time, from older data, is dated by its start.
 */
export function hasUnseenRunFailure(
  thread: Pick<EnvironmentThreadShell, "latestRun"> & {
    readonly lastVisitedAt?: string | null | undefined;
  },
): boolean {
  const run = thread.latestRun;
  if (run?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const failedAtMs = Date.parse(run.completedAt ?? run.startedAt ?? run.requestedAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(failedAtMs) || Number.isNaN(lastVisitedAtMs)) return true;
  return failedAtMs > lastVisitedAtMs;
}

// Typed snooze times: a bare day wakes in the morning, "evening" at six.
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const DAY_MS = 24 * HOUR_MS;

function snoozeAtHour(base: Date, hour: number, minute = 0): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setHours(hour, minute, 0, 0);
  return next;
}

function nextMondayMorning(now: Date): Date {
  return snoozeAtHour(addSnoozeDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR);
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
 * Free-text snooze time: durations ("1h30m", "in 3h"), times ("2pm": today, else tomorrow),
 * days ("fri", "oct 20 8am"; 9:00 by default), "evening", "next week"; past and unknown differ.
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
