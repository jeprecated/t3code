import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const sent = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (_registry: unknown, _command: unknown, args: unknown) => {
    sent.calls.push(args);
    return { _tag: "Success" };
  },
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => null,
}));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: () => "toast", close: () => {} },
}));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./state/server", () => ({ serverEnvironment: { resolveThreadWait: {} } }));

import { scheduleWaitResolve, undoWaitResolve, usePendingWaitResolves } from "./threadWaitResolves";

const environmentId = EnvironmentId.make("env-1");
const answer = (threadId: string, waitId: string, note?: string) =>
  scheduleWaitResolve({
    environmentId,
    threadId: ThreadId.make(threadId),
    threadTitle: "Book",
    waitId,
    setAt: "2026-11-19T09:00:00.000Z",
    note,
  });

function setup() {
  sent.calls = [];
  usePendingWaitResolves.setState({ pending: new Map(), batches: new Map() });
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

describe("scheduleWaitResolve", () => {
  it("sends a thread's answers together once the last one's Undo window ends", () => {
    setup();
    answer("thread-1", "cover", "Leave it");
    answer("thread-2", "deploy");
    vi.advanceTimersByTime(4_000);
    answer("thread-1", "gate", "In a new thread");
    vi.advanceTimersByTime(4_000);
    expect(sent.calls).toEqual([
      { environmentId, input: { threadId: "thread-2", answers: [{ waitId: "deploy" }] } },
    ]);
    vi.advanceTimersByTime(1_000);
    expect(sent.calls[1]).toEqual({
      environmentId,
      input: {
        threadId: "thread-1",
        answers: [
          { waitId: "cover", note: "Leave it" },
          { waitId: "gate", note: "In a new thread" },
        ],
      },
    });
  });

  it("takes back one answer and still sends the thread's others", () => {
    setup();
    const cover = answer("thread-1", "cover");
    answer("thread-1", "gate");
    expect(undoWaitResolve(cover)).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(sent.calls).toEqual([
      { environmentId, input: { threadId: "thread-1", answers: [{ waitId: "gate" }] } },
    ]);
    expect(undoWaitResolve(cover)).toBe(false);
  });
});
