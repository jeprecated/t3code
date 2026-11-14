import {
  type TaskSnooze,
  type TaskSnoozeClearInput,
  type TaskSnoozeClearResult,
  type TaskSnoozeListResult,
  TaskSnoozePersistenceError,
  type TaskSnoozeSetInput,
  type TaskSnoozeSetResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

interface TaskSnoozeRow {
  readonly key: string;
  readonly snoozed_until: string;
  readonly snoozed_at: string;
}

export class TaskSnoozeService extends Context.Service<
  TaskSnoozeService,
  {
    readonly list: () => Effect.Effect<TaskSnoozeListResult, TaskSnoozePersistenceError>;
    readonly subscribeList: () => Stream.Stream<TaskSnoozeListResult, TaskSnoozePersistenceError>;
    readonly set: (
      input: TaskSnoozeSetInput,
    ) => Effect.Effect<TaskSnoozeSetResult, TaskSnoozePersistenceError>;
    /** Succeeds when the key has no snooze. */
    readonly clear: (
      input: TaskSnoozeClearInput,
    ) => Effect.Effect<TaskSnoozeClearResult, TaskSnoozePersistenceError>;
  }
>()("t3/taskSnoozes/TaskSnoozeService") {}

const snoozeFromRow = (row: TaskSnoozeRow): TaskSnooze => ({
  key: row.key,
  snoozedUntil: row.snoozed_until,
  snoozedAt: row.snoozed_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Subscribers only need to know the list changed; each re-reads it.
  const changes = yield* PubSub.sliding<void>(1);

  // Stored times are all `formatIso` output, so SQL can compare them as strings.
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const writeError = (cause: unknown) =>
    new TaskSnoozePersistenceError({ operation: "write", cause });

  const list = Effect.fn("TaskSnoozeService.list")(function* () {
    const now = yield* nowIso;
    const rows = yield* sql<TaskSnoozeRow>`
      SELECT * FROM task_snoozes WHERE snoozed_until > ${now} ORDER BY snoozed_until, key
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new TaskSnoozePersistenceError({ operation: "list", cause })),
    );
    return { snoozes: rows.map(snoozeFromRow) };
  });

  const subscribeList: TaskSnoozeService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change during the read still re-emits.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const set: TaskSnoozeService["Service"]["set"] = Effect.fn("TaskSnoozeService.set")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ "task_snooze.key": input.key });
      const now = yield* nowIso;
      const snooze = {
        key: input.key,
        // The input schema only admits parseable times.
        snoozedUntil: DateTime.formatIso(DateTime.makeUnsafe(input.snoozedUntil)),
        snoozedAt: now,
      };
      yield* sql
        .withTransaction(
          Effect.all([
            sql`DELETE FROM task_snoozes WHERE snoozed_until <= ${now}`,
            sql`
              INSERT INTO task_snoozes (key, snoozed_until, snoozed_at)
              VALUES (${snooze.key}, ${snooze.snoozedUntil}, ${snooze.snoozedAt})
              ON CONFLICT (key) DO UPDATE SET
                snoozed_until = excluded.snoozed_until,
                snoozed_at = excluded.snoozed_at
            `,
          ]),
        )
        .pipe(Effect.mapError(writeError));
      yield* PubSub.publish(changes, undefined);
      return { snooze };
    },
  );

  const clear: TaskSnoozeService["Service"]["clear"] = Effect.fn("TaskSnoozeService.clear")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ "task_snooze.key": input.key });
      const now = yield* nowIso;
      const deleted = yield* sql<{ readonly key: string }>`
        DELETE FROM task_snoozes WHERE key = ${input.key} OR snoozed_until <= ${now} RETURNING key
      `.pipe(Effect.mapError(writeError));
      // Waits and todos clear their key whether or not it was snoozed; skip those no-op pushes.
      if (deleted.some((row) => row.key === input.key)) yield* PubSub.publish(changes, undefined);
      return { key: input.key };
    },
  );

  return TaskSnoozeService.of({ list, subscribeList, set, clear });
});

export const layer = Layer.effect(TaskSnoozeService, make);
