import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  citationQuote,
  cockpitCardCommands,
  cockpitPrimary,
  cycleRegion,
  detailLinks,
  keyAfter,
  optionIndexForKey,
  resolveCockpitCard,
  rovingTarget,
  stepKey,
  waitResolveNote,
  type CockpitCard,
} from "./cockpit.logic";

const requestId = RuntimeRequestId.make("request");
const approval: ThreadPendingApproval = {
  requestId,
  requestKind: "command",
  createdAt: "2026-06-20T10:00:00.000Z",
  responseCapability: "live",
};
const userInput: ThreadPendingUserInput = {
  requestId,
  createdAt: "2026-06-20T10:00:00.000Z",
  questions: [],
  responseCapability: "live",
  dismissible: false,
};
const item = (
  overrides: Partial<Pick<CockpitItem, "kind" | "requestId" | "wait" | "todo">>,
): Pick<CockpitItem, "kind" | "requestId" | "wait" | "todo"> => ({
  kind: "question",
  requestId,
  wait: null,
  todo: null,
  ...overrides,
});

describe("regions and roving focus", () => {
  it("cycles regions both ways and skips empty ones", () => {
    const all = () => true;
    expect(cycleRegion("card", 1, all)).toBe("upNext");
    expect(cycleRegion("overview", 1, all)).toBe("card");
    expect(cycleRegion("card", -1, all)).toBe("overview");
    const noUpNext = (region: string) => region !== "upNext";
    expect(cycleRegion("card", 1, noUpNext)).toBe("overview");
    expect(cycleRegion("overview", -1, noUpNext)).toBe("card");
    expect(cycleRegion("card", 1, (region) => region === "card")).toBe("card");
  });

  it("moves within a region without wrapping, entering from either end", () => {
    expect(rovingTarget(-1, 3, "ArrowDown")).toBe(0);
    expect(rovingTarget(-1, 3, "ArrowUp")).toBe(2);
    expect(rovingTarget(0, 3, "ArrowRight")).toBe(1);
    expect(rovingTarget(2, 3, "ArrowDown")).toBe(2);
    expect(rovingTarget(0, 3, "ArrowLeft")).toBe(0);
    expect(rovingTarget(1, 3, "Home")).toBe(0);
    expect(rovingTarget(1, 3, "End")).toBe(2);
    expect(rovingTarget(1, 3, "Enter")).toBeNull();
    expect(rovingTarget(-1, 0, "ArrowDown")).toBeNull();
  });

  it("maps number keys to options that exist", () => {
    expect(optionIndexForKey("1", 3)).toBe(0);
    expect(optionIndexForKey("3", 3)).toBe(2);
    expect(optionIndexForKey("4", 3)).toBeNull();
    expect(optionIndexForKey("0", 3)).toBeNull();
    expect(optionIndexForKey("e", 3)).toBeNull();
  });

  it("steps through tasks, and lands after the finished one", () => {
    expect(stepKey(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepKey(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepKey(["a", "b"], null, -1)).toBe("b");
    expect(stepKey([], "a", 1)).toBeNull();
    expect(keyAfter(["a", "b", "c"], "b")).toBe("c");
    expect(keyAfter(["a", "b", "c"], "c")).toBe("b");
    expect(keyAfter(["a"], "a")).toBeNull();
    expect(keyAfter(["a", "b"], "gone")).toBe("a");
  });
});

describe("cards", () => {
  it("reads live asks from the thread's requests", () => {
    expect(resolveCockpitCard(item({}), null)).toEqual({ type: "loading" });
    expect(
      resolveCockpitCard(item({ kind: "approval" }), { approvals: [approval], userInputs: [] }),
    ).toEqual({ type: "approval", approval });
    expect(resolveCockpitCard(item({}), { approvals: [], userInputs: [userInput] })).toEqual({
      type: "question",
      input: userInput,
    });
    // A secret or link card has no question; neither does a request the provider lost.
    expect(resolveCockpitCard(item({}), { approvals: [], userInputs: [] })).toEqual({
      type: "elsewhere",
    });
    expect(
      resolveCockpitCard(item({ kind: "approval" }), {
        approvals: [{ ...approval, responseCapability: "not_resumable" }],
        userInputs: [],
      }),
    ).toEqual({ type: "elsewhere" });
    expect(resolveCockpitCard(item({ kind: "approval", requestId: null }), null)).toEqual({
      type: "elsewhere",
    });
    expect(resolveCockpitCard(item({ kind: "plan", requestId: null }), null)).toEqual({
      type: "elsewhere",
    });
    expect(
      resolveCockpitCard(
        item({ kind: "review", requestId: null, wait: { id: "w", kind: "review", summary: "s" } }),
        null,
      ),
    ).toEqual({ type: "wait", kind: "review" });
  });

  it("resolves the primary action per card", () => {
    const primary = (card: CockpitCard, note = "", hasThread = true) =>
      cockpitPrimary(card, { note, hasThread });
    expect(primary({ type: "approval", approval })?.action).toBe("approve");
    expect(primary({ type: "question", input: userInput })?.action).toBe("submit");
    expect(primary({ type: "wait", kind: "manual_step" })).toEqual({
      action: "resolve",
      label: "Done",
    });
    expect(primary({ type: "wait", kind: "review" })?.label).toBe("Looks good");
    expect(primary({ type: "wait", kind: "review" }, "Tighten the copy")?.label).toBe(
      "Send feedback",
    );
    expect(primary({ type: "todo" }, "", false)?.action).toBe("complete");
    expect(primary({ type: "elsewhere" })?.action).toBe("openThere");
    expect(primary({ type: "elsewhere" }, "", false)).toBeNull();
    expect(primary({ type: "loading" })).toBeNull();
  });

  it("offers approve-for-thread only where the provider does", () => {
    const flags = { hasThread: true, hasLinks: false, hasReply: false };
    expect(cockpitCardCommands({ type: "approval", approval }, flags)).toEqual([
      "cockpit.primary",
      "cockpit.approve",
      "cockpit.approveForThread",
      "cockpit.deny",
      "cockpit.snooze",
      "cockpit.openThere",
    ]);
    expect(
      cockpitCardCommands(
        {
          type: "approval",
          approval: {
            ...approval,
            options: [
              { decision: "decline", label: "No" },
              { decision: "accept", label: "Yes" },
            ],
          },
        },
        flags,
      ),
    ).not.toContain("cockpit.approveForThread");
    expect(
      cockpitCardCommands({ type: "todo" }, { hasThread: false, hasLinks: true, hasReply: true }),
    ).toEqual(["cockpit.primary", "cockpit.snooze", "cockpit.reply", "cockpit.openLink"]);
  });

  it("tells the agent what was chosen, and that a review looks good", () => {
    expect(waitResolveNote("decision", "", "Flat seats")).toBe("Chose: Flat seats");
    expect(waitResolveNote("decision", " and ship it ", "Flat seats")).toBe(
      "Chose: Flat seats\n\nand ship it",
    );
    expect(waitResolveNote("manual_step", "  ")).toBeUndefined();
    expect(waitResolveNote("review", "")).toBe("Looks good.");
    expect(waitResolveNote("review", "Fix the header")).toBe("Fix the header");
  });
});

describe("links and citations", () => {
  it("lists a detail's links once, in order", () => {
    expect(
      detailLinks(
        "Open [the dashboard](https://dash.example.com/keys), then <https://a.example> or https://b.example/x. Again: https://dash.example.com/keys",
      ),
    ).toEqual(["https://dash.example.com/keys", "https://a.example", "https://b.example/x"]);
    expect(detailLinks(undefined)).toEqual([]);
  });

  it("quotes a plain run of the message that renders as written", () => {
    expect(citationQuote("## Done\n- Built **and tested** the whole flow in a VM today")).toBe(
      "the whole flow in a VM today",
    );
    const long = `${"word ".repeat(40)}end`;
    expect(citationQuote(long)?.length).toBeLessThanOrEqual(120);
    expect(citationQuote(long)?.endsWith("word")).toBe(true);
    expect(citationQuote("`code` *x*")).toBeNull();
  });
});
