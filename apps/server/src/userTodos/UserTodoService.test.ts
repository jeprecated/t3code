import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UserTodoService from "./UserTodoService.ts";

const layerTest = UserTodoService.layer.pipe(
  Layer.provide(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer)),
);

const titles = (result: { readonly todos: ReadonlyArray<{ readonly title: string }> }) =>
  result.todos.map((todo) => todo.title);

it.effect("creates, updates, completes, reopens and deletes todos, and lists them in order", () =>
  Effect.gen(function* () {
    const todos = yield* UserTodoService.UserTodoService;
    const { todo: call } = yield* todos.upsert({
      title: "Call the bank",
      where: "phone",
      createdBy: "user",
    });
    yield* TestClock.adjust("1 second");
    const { todo: renew } = yield* todos.upsert({
      title: "Renew the domain",
      notes: "acme.app at the registrar",
      createdBy: "agent",
    });
    assert.deepEqual(titles(yield* todos.list()), ["Call the bank", "Renew the domain"]);

    const updated = yield* todos.upsert({
      id: renew.id,
      title: "Renew acme.app",
      notBefore: "2026-11-20T09:00:00.000Z",
      createdBy: "user",
    });
    assert.deepInclude(updated.todo, {
      title: "Renew acme.app",
      notes: "acme.app at the registrar",
      notBefore: "2026-11-20T09:00:00.000Z",
      createdBy: "agent",
    });
    assert.notProperty(
      (yield* todos.upsert({ id: call.id, where: null, createdBy: "user" })).todo,
      "where",
    );

    yield* todos.setCompleted({ id: call.id, completed: true });
    assert.deepEqual(titles(yield* todos.list()), ["Renew acme.app", "Call the bank"]);
    assert.isNull((yield* todos.setCompleted({ id: call.id, completed: false })).todo.completedAt);
    assert.deepEqual(titles(yield* todos.list()), ["Call the bank", "Renew acme.app"]);

    yield* todos.setCompleted({ id: call.id, completed: true });
    yield* TestClock.adjust("8 days");
    assert.deepEqual(titles(yield* todos.list()), ["Renew acme.app"]);

    assert.deepEqual(yield* todos.delete({ id: renew.id }), { id: renew.id });
    assert.deepEqual((yield* todos.list()).todos, []);
    const missing = yield* todos.delete({ id: renew.id }).pipe(Effect.flip);
    assert.equal(missing._tag, "UserTodoNotFoundError");
    const untitled = yield* todos.upsert({ createdBy: "user" }).pipe(Effect.flip);
    assert.equal(untitled._tag, "UserTodoTitleRequiredError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("emits the full list on subscribe and after each change", () =>
  Effect.gen(function* () {
    const todos = yield* UserTodoService.UserTodoService;
    const emitted = yield* Queue.unbounded<ReadonlyArray<string>>();
    yield* todos.subscribeList().pipe(
      Stream.runForEach((result) => Queue.offer(emitted, titles(result))),
      Effect.forkChild,
    );
    assert.deepEqual(yield* Queue.take(emitted), []);
    const { todo } = yield* todos.upsert({ title: "Pick up keys", createdBy: "user" });
    assert.deepEqual(yield* Queue.take(emitted), ["Pick up keys"]);
    yield* todos.delete({ id: todo.id });
    assert.deepEqual(yield* Queue.take(emitted), []);
  }).pipe(Effect.provide(layerTest)),
);
