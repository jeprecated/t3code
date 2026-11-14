import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TaskSnoozeService from "./TaskSnoozeService.ts";

const layerTest = TaskSnoozeService.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const keys = (result: { readonly snoozes: ReadonlyArray<{ readonly key: string }> }) =>
  result.snoozes.map((snooze) => snooze.key);

it.effect("sets, replaces, expires and clears snoozes", () =>
  Effect.gen(function* () {
    const snoozes = yield* TaskSnoozeService.TaskSnoozeService;
    const sql = yield* SqlClient.SqlClient;
    // TestClock starts at the epoch.
    const { snooze } = yield* snoozes.set({ key: "todo:a", snoozedUntil: "1970-01-01T02:00:00Z" });
    assert.deepEqual(snooze, {
      key: "todo:a",
      snoozedUntil: "1970-01-01T02:00:00.000Z",
      snoozedAt: "1970-01-01T00:00:00.000Z",
    });
    yield* snoozes.set({ key: "wait:t:b", snoozedUntil: "1970-01-01T01:00:00.000Z" });
    assert.deepEqual(keys(yield* snoozes.list()), ["wait:t:b", "todo:a"]);
    yield* snoozes.set({ key: "wait:t:b", snoozedUntil: "1970-01-01T03:00:00.000Z" });
    assert.deepEqual(keys(yield* snoozes.list()), ["todo:a", "wait:t:b"]);

    yield* TestClock.adjust("2 hours");
    assert.deepEqual(keys(yield* snoozes.list()), ["wait:t:b"]);
    assert.lengthOf(yield* sql`SELECT key FROM task_snoozes`, 2);
    yield* snoozes.clear({ key: "thread:never-snoozed" });
    assert.deepEqual(yield* sql`SELECT key FROM task_snoozes`, [{ key: "wait:t:b" }]);

    assert.deepEqual(yield* snoozes.clear({ key: "wait:t:b" }), { key: "wait:t:b" });
    assert.deepEqual((yield* snoozes.list()).snoozes, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("emits the current list on subscribe and after each change", () =>
  Effect.gen(function* () {
    const snoozes = yield* TaskSnoozeService.TaskSnoozeService;
    const emitted = yield* Queue.unbounded<ReadonlyArray<string>>();
    yield* snoozes.subscribeList().pipe(
      Stream.runForEach((result) => Queue.offer(emitted, keys(result))),
      Effect.forkChild,
    );
    assert.deepEqual(yield* Queue.take(emitted), []);
    yield* snoozes.set({ key: "todo:a", snoozedUntil: "1970-01-02T00:00:00.000Z" });
    assert.deepEqual(yield* Queue.take(emitted), ["todo:a"]);
    yield* snoozes.clear({ key: "todo:a" });
    assert.deepEqual(yield* Queue.take(emitted), []);
  }).pipe(Effect.provide(layerTest)),
);
