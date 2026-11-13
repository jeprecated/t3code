import {
  type UserTodo,
  type UserTodoDeleteInput,
  type UserTodoDeleteResult,
  UserTodoId,
  type UserTodoListResult,
  type UserTodoMutationResult,
  UserTodoNotFoundError,
  UserTodoPersistenceError,
  type UserTodoSetCompletedInput,
  UserTodoTitleRequiredError,
  type UserTodoUpsertInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

/** Completed todos stay listed this long, so a mistaken tick can be undone. */
const COMPLETED_RETENTION = { days: 7 } as const;

interface UserTodoRow {
  readonly todo_id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly location: string | null;
  readonly not_before: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

export class UserTodoService extends Context.Service<
  UserTodoService,
  {
    readonly list: () => Effect.Effect<UserTodoListResult, UserTodoPersistenceError>;
    readonly subscribeList: () => Stream.Stream<UserTodoListResult, UserTodoPersistenceError>;
    readonly upsert: (
      input: UserTodoUpsertInput & { readonly createdBy: UserTodo["createdBy"] },
    ) => Effect.Effect<
      UserTodoMutationResult,
      UserTodoNotFoundError | UserTodoTitleRequiredError | UserTodoPersistenceError
    >;
    readonly setCompleted: (
      input: UserTodoSetCompletedInput,
    ) => Effect.Effect<UserTodoMutationResult, UserTodoNotFoundError | UserTodoPersistenceError>;
    readonly delete: (
      input: UserTodoDeleteInput,
    ) => Effect.Effect<UserTodoDeleteResult, UserTodoNotFoundError | UserTodoPersistenceError>;
  }
>()("t3/userTodos/UserTodoService") {}

function todoFromRow(row: UserTodoRow): UserTodo {
  return {
    id: UserTodoId.make(row.todo_id),
    title: row.title,
    ...(row.notes === null ? {} : { notes: row.notes }),
    ...(row.location === null ? {} : { where: row.location }),
    ...(row.not_before === null ? {} : { notBefore: row.not_before }),
    createdBy: row.created_by === "agent" ? "agent" : "user",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);
  // Subscribers only need to know the list changed; each re-reads it.
  const changes = yield* PubSub.sliding<void>(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const cutoffIso = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.subtract(now, COMPLETED_RETENTION))),
  );
  const writeError = (cause: unknown) =>
    new UserTodoPersistenceError({ operation: "write", cause });

  const list = Effect.fn("UserTodoService.list")(function* () {
    const cutoff = yield* cutoffIso;
    const rows = yield* sql<UserTodoRow>`
      SELECT * FROM user_todos
      WHERE completed_at IS NULL OR completed_at >= ${cutoff}
      ORDER BY completed_at IS NOT NULL, completed_at DESC, created_at ASC, todo_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new UserTodoPersistenceError({ operation: "list", cause })),
    );
    return { todos: rows.map(todoFromRow) };
  });

  const subscribeList: UserTodoService["Service"]["subscribeList"] = () =>
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

  const find = Effect.fn("UserTodoService.find")(function* (id: UserTodoId) {
    const rows = yield* sql<UserTodoRow>`SELECT * FROM user_todos WHERE todo_id = ${id}`.pipe(
      Effect.mapError(writeError),
    );
    const row = rows[0];
    if (row === undefined) return yield* new UserTodoNotFoundError({ id });
    return todoFromRow(row);
  });

  const save = Effect.fn("UserTodoService.save")(function* (todo: UserTodo) {
    const cutoff = yield* cutoffIso;
    yield* sql
      .withTransaction(
        Effect.all([
          sql`
            INSERT INTO user_todos (
              todo_id, title, notes, location, not_before,
              created_by, created_at, updated_at, completed_at
            ) VALUES (
              ${todo.id}, ${todo.title}, ${todo.notes ?? null}, ${todo.where ?? null},
              ${todo.notBefore ?? null}, ${todo.createdBy}, ${todo.createdAt},
              ${todo.updatedAt}, ${todo.completedAt}
            )
            ON CONFLICT (todo_id) DO UPDATE SET
              title = excluded.title,
              notes = excluded.notes,
              location = excluded.location,
              not_before = excluded.not_before,
              updated_at = excluded.updated_at,
              completed_at = excluded.completed_at
          `,
          sql`DELETE FROM user_todos WHERE completed_at IS NOT NULL AND completed_at < ${cutoff}`,
        ]),
      )
      .pipe(Effect.mapError(writeError));
    yield* PubSub.publish(changes, undefined);
    return { todo };
  });

  const upsert: UserTodoService["Service"]["upsert"] = Effect.fn("UserTodoService.upsert")(
    function* (input) {
      const now = yield* nowIso;
      if (input.id === undefined) {
        if (input.title === undefined) return yield* new UserTodoTitleRequiredError();
        const id = UserTodoId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        return yield* save({
          id,
          title: input.title,
          ...(input.notes == null ? {} : { notes: input.notes }),
          ...(input.where == null ? {} : { where: input.where }),
          ...(input.notBefore == null ? {} : { notBefore: input.notBefore }),
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
      }
      const existing = yield* find(input.id);
      const { notes, where, notBefore, ...kept } = existing;
      const merged = {
        notes: input.notes === undefined ? notes : input.notes,
        where: input.where === undefined ? where : input.where,
        notBefore: input.notBefore === undefined ? notBefore : input.notBefore,
      };
      return yield* save({
        ...kept,
        title: input.title ?? existing.title,
        ...(merged.notes == null ? {} : { notes: merged.notes }),
        ...(merged.where == null ? {} : { where: merged.where }),
        ...(merged.notBefore == null ? {} : { notBefore: merged.notBefore }),
        updatedAt: now,
      });
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const setCompleted: UserTodoService["Service"]["setCompleted"] = Effect.fn(
    "UserTodoService.setCompleted",
  )(
    function* (input) {
      const existing = yield* find(input.id);
      if ((existing.completedAt !== null) === input.completed) return { todo: existing };
      const now = yield* nowIso;
      return yield* save({
        ...existing,
        completedAt: input.completed ? now : null,
        updatedAt: now,
      });
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const deleteTodo: UserTodoService["Service"]["delete"] = Effect.fn("UserTodoService.delete")(
    function* (input) {
      const deleted = yield* sql<{ readonly todo_id: string }>`
        DELETE FROM user_todos WHERE todo_id = ${input.id} RETURNING todo_id
      `.pipe(Effect.mapError(writeError));
      if (deleted.length === 0) return yield* new UserTodoNotFoundError({ id: input.id });
      yield* PubSub.publish(changes, undefined);
      return { id: input.id };
    },
    (effect) => writes.withPermits(1)(effect),
  );

  return UserTodoService.of({ list, subscribeList, upsert, setCompleted, delete: deleteTodo });
});

export const layer = Layer.effect(UserTodoService, make);
