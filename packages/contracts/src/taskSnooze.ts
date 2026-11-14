import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Opaque to the server, which only clears the wait and todo keys it can build below. */
export const TaskKey = TrimmedNonEmptyString.check(Schema.isMaxLength(300));
export type TaskKey = typeof TaskKey.Type;

export const taskWaitKey = (threadId: string, waitId: string): TaskKey =>
  `wait:${threadId}:${waitId}`;
export const taskRequestKey = (threadId: string, requestId: string): TaskKey =>
  `request:${threadId}:${requestId}`;
export const taskThreadKey = (threadId: string): TaskKey => `thread:${threadId}`;
export const taskTodoKey = (todoId: string): TaskKey => `todo:${todoId}`;

const TaskSnoozeUntil = IsoDateTime.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected an ISO date-time."),
);

/** One task the user put off without snoozing its thread; synced across their devices. */
export const TaskSnooze = Schema.Struct({
  key: TaskKey,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
});
export type TaskSnooze = typeof TaskSnooze.Type;

export const TaskSnoozeListInput = Schema.Struct({});
export type TaskSnoozeListInput = typeof TaskSnoozeListInput.Type;

/** Snoozes still in effect. */
export const TaskSnoozeListResult = Schema.Struct({
  snoozes: ForwardCompatibleArray(TaskSnooze),
});
export type TaskSnoozeListResult = typeof TaskSnoozeListResult.Type;

export const TaskSnoozeSetInput = Schema.Struct({
  key: TaskKey,
  snoozedUntil: TaskSnoozeUntil,
});
export type TaskSnoozeSetInput = typeof TaskSnoozeSetInput.Type;

export const TaskSnoozeSetResult = Schema.Struct({ snooze: TaskSnooze });
export type TaskSnoozeSetResult = typeof TaskSnoozeSetResult.Type;

export const TaskSnoozeClearInput = Schema.Struct({ key: TaskKey });
export type TaskSnoozeClearInput = typeof TaskSnoozeClearInput.Type;

export const TaskSnoozeClearResult = Schema.Struct({ key: TaskKey });
export type TaskSnoozeClearResult = typeof TaskSnoozeClearResult.Type;

export class TaskSnoozePersistenceError extends Schema.TaggedError<TaskSnoozePersistenceError>()(
  "TaskSnoozePersistenceError",
  { operation: Schema.Literals(["list", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "list" ? "Could not read snoozes." : "Could not save the snooze.";
  }
}
