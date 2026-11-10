import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadLinkTarget,
  type ThreadLinkLookup,
  type ThreadLinkThreadState,
} from "./threadLinkTarget.ts";

const ref = (environmentId: string, threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});
const local = EnvironmentId.make("local");

function lookup(input: {
  readonly environments?: Record<string, { label: string; connected: boolean }>;
  readonly listed?: ReadonlyArray<ScopedThreadRef>;
  readonly threads?: Record<string, ThreadLinkThreadState>;
}): ThreadLinkLookup & { readonly asked: Array<string> } {
  const asked: Array<string> = [];
  return {
    asked,
    environment: (environmentId) => input.environments?.[environmentId] ?? null,
    listedRefs: () => input.listed ?? [],
    thread: async (target) => {
      const key = `${target.environmentId}/${target.threadId}`;
      asked.push(key);
      return input.threads?.[key] ?? "missing";
    },
  };
}

const resolve = (href: string, from: ReturnType<typeof lookup>, primary: EnvironmentId | null) =>
  resolveThreadLinkTarget(parseThreadLinkHref(href)!, primary, from);

describe("resolveThreadLinkTarget", () => {
  const environments = {
    local: { label: "This Mac", connected: true },
    vps: { label: "VPS", connected: false },
  };

  it("opens an encoded v2 link's thread by its decoded id, archived ones as archived", async () => {
    const threadId = "thread:project:1:2";
    const encoded = `t3-thread://v2/local/${encodeURIComponent(threadId)}`;
    const open = lookup({ environments, threads: { [`local/${threadId}`]: "open" } });
    expect(await resolve(encoded, open, null)).toEqual({
      kind: "open",
      ref: ref("local", threadId),
    });
    expect(open.asked).toEqual([`local/${encodeURIComponent(threadId)}`, `local/${threadId}`]);
    const archived = lookup({ environments, threads: { [`local/${threadId}`]: "archived" } });
    expect(await resolve(encoded, archived, null)).toEqual({
      kind: "archived",
      ref: ref("local", threadId),
    });
  });

  it("explains an unknown environment, an offline one and a missing thread", async () => {
    const from = lookup({ environments });
    expect(await resolve("t3-thread://v2/elsewhere/chat-1", from, local)).toEqual({
      kind: "unavailable",
      reason: "The thread is on environment elsewhere, which this app isn't connected to.",
    });
    expect(await resolve("t3-thread://v2/vps/chat-1", from, local)).toEqual({
      kind: "unavailable",
      reason: "VPS is offline.",
    });
    expect(await resolve("t3-thread://v2/local/chat-1", from, local)).toEqual({
      kind: "unavailable",
      reason: "This Mac has no such thread. It may have been deleted.",
    });
    expect(from.asked).toEqual(["local/chat-1"]);
  });

  it("opens a v1 link's unique listed thread anywhere, else looks in the primary environment", async () => {
    const listed = [ref("vps", "chat-1"), ref("local", "chat-2")];
    expect(await resolve("t3-thread://v1/chat-1", lookup({ environments, listed }), local)).toEqual(
      { kind: "open", ref: ref("vps", "chat-1") },
    );
    const unlisted = lookup({ environments, listed, threads: { "local/chat-3": "archived" } });
    expect(await resolve("t3-thread://v1/chat-3", unlisted, local)).toEqual({
      kind: "archived",
      ref: ref("local", "chat-3"),
    });
    expect(await resolve("t3-thread://v1/chat-3", lookup({ environments }), null)).toEqual({
      kind: "unavailable",
      reason: "No connected environment has this thread.",
    });
  });
});
