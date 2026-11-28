import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const UserTodoId = TrimmedNonEmptyString.pipe(Schema.brand("UserTodoId"));
export type UserTodoId = typeof UserTodoId.Type;

const UserTodoTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const UserTodoNotes = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const UserTodoWhere = TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
  description: "Where the user must be or what they need, such as: iPhone in hand.",
});
const UserTodoNotBefore = IsoDateTime.annotate({ description: "Not doable before this time." });

/** Something the user means to do themselves, kept per environment. */
export const UserTodo = Schema.Struct({
  id: UserTodoId,
  title: UserTodoTitle,
  notes: Schema.optional(UserTodoNotes),
  where: Schema.optional(UserTodoWhere),
  notBefore: Schema.optional(UserTodoNotBefore),
  createdBy: Schema.Literals(["user", "agent"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type UserTodo = typeof UserTodo.Type;

export const UserTodoListInput = Schema.Struct({});
export type UserTodoListInput = typeof UserTodoListInput.Type;

/** Open todos oldest first, then those completed in the last 7 days. */
export const UserTodoListResult = Schema.Struct({
  todos: ForwardCompatibleArray(UserTodo),
});
export type UserTodoListResult = typeof UserTodoListResult.Type;

/** Creates without `id`. On update an omitted field is kept and `null` clears it. */
export const UserTodoUpsertInput = Schema.Struct({
  id: Schema.optional(UserTodoId),
  title: Schema.optional(UserTodoTitle),
  notes: Schema.optional(Schema.NullOr(UserTodoNotes)),
  where: Schema.optional(Schema.NullOr(UserTodoWhere)),
  notBefore: Schema.optional(Schema.NullOr(UserTodoNotBefore)),
});
export type UserTodoUpsertInput = typeof UserTodoUpsertInput.Type;

export const UserTodoSetCompletedInput = Schema.Struct({
  id: UserTodoId,
  completed: Schema.Boolean,
});
export type UserTodoSetCompletedInput = typeof UserTodoSetCompletedInput.Type;

export const UserTodoDeleteInput = Schema.Struct({ id: UserTodoId });
export type UserTodoDeleteInput = typeof UserTodoDeleteInput.Type;

export const UserTodoMutationResult = Schema.Struct({ todo: UserTodo });
export type UserTodoMutationResult = typeof UserTodoMutationResult.Type;

export const UserTodoDeleteResult = Schema.Struct({ id: UserTodoId });
export type UserTodoDeleteResult = typeof UserTodoDeleteResult.Type;

export class UserTodoNotFoundError extends Schema.TaggedError<UserTodoNotFoundError>()(
  "UserTodoNotFoundError",
  { id: UserTodoId },
) {
  override get message(): string {
    return `Todo ${this.id} was not found.`;
  }
}

export class UserTodoTitleRequiredError extends Schema.TaggedError<UserTodoTitleRequiredError>()(
  "UserTodoTitleRequiredError",
  {},
) {
  override get message(): string {
    return "A new todo needs a title.";
  }
}

export class UserTodoPersistenceError extends Schema.TaggedError<UserTodoPersistenceError>()(
  "UserTodoPersistenceError",
  { operation: Schema.Literals(["list", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "list" ? "Could not read todos." : "Could not save the todo.";
  }
}

export const UserTodoError = Schema.Union([
  UserTodoNotFoundError,
  UserTodoTitleRequiredError,
  UserTodoPersistenceError,
]);
export type UserTodoError = typeof UserTodoError.Type;
