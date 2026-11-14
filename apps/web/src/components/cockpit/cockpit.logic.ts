import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  CockpitKeybindingCommand,
  OrchestrationV2ThreadWaitKind,
  ProviderApprovalDecision,
} from "@t3tools/contracts";

export type CockpitRegion = "card" | "upNext" | "overview";

const REGIONS: ReadonlyArray<CockpitRegion> = ["card", "upNext", "overview"];

/** Tab and Shift+Tab: each region is one stop, and an empty one is skipped. */
export function cycleRegion(
  current: CockpitRegion,
  step: 1 | -1,
  available: (region: CockpitRegion) => boolean,
): CockpitRegion {
  const at = REGIONS.indexOf(current);
  for (let offset = 1; offset < REGIONS.length; offset += 1) {
    const candidate = REGIONS[(at + step * offset + REGIONS.length * 2) % REGIONS.length]!;
    if (available(candidate)) return candidate;
  }
  return current;
}

/**
 * Where arrow keys move focus among a region's `count` stops. `current` is -1 when the region
 * itself has focus. Null leaves the key alone.
 */
export function rovingTarget(current: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return current < 0 ? 0 : Math.min(count - 1, current + 1);
    case "ArrowUp":
    case "ArrowLeft":
      return current < 0 ? count - 1 : Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Number keys pick options: "1" is the first. */
export function optionIndexForKey(key: string, count: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index < count ? index : null;
}

/** The key after `current`, else the one before it: where the cockpit goes once it is done. */
export function keyAfter(keys: ReadonlyArray<string>, current: string): string | null {
  const at = keys.indexOf(current);
  if (at < 0) return keys[0] ?? null;
  return keys[at + 1] ?? keys[at - 1] ?? null;
}

/** j/k: the neighbouring key, wrapping. */
export function stepKey(
  keys: ReadonlyArray<string>,
  current: string | null,
  step: 1 | -1,
): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return keys[step === 1 ? 0 : keys.length - 1]!;
  return keys[(at + step + keys.length) % keys.length]!;
}

/** How a card looks and acts, once the source thread says what the live request is. */
export type CockpitCard =
  | { readonly type: "loading" }
  | { readonly type: "approval"; readonly approval: ThreadPendingApproval }
  | { readonly type: "question"; readonly input: ThreadPendingUserInput }
  /** A secret, link, sign-in or subagent ask, a plan, or a failure: the thread handles it. */
  | { readonly type: "elsewhere" }
  | { readonly type: "wait"; readonly kind: OrchestrationV2ThreadWaitKind }
  | { readonly type: "todo" };

export function resolveCockpitCard(
  item: Pick<CockpitItem, "kind" | "requestId" | "wait" | "todo">,
  requests: PendingThreadRequests | null,
): CockpitCard {
  if (item.todo !== null) return { type: "todo" };
  if (item.wait !== null) return { type: "wait", kind: item.wait.kind };
  if ((item.kind === "approval" || item.kind === "question") && item.requestId !== null) {
    if (requests === null) return { type: "loading" };
    const approval = requests.approvals.find((entry) => entry.requestId === item.requestId);
    if (approval !== undefined && approval.responseCapability === "live") {
      return { type: "approval", approval };
    }
    const input = requests.userInputs.find((entry) => entry.requestId === item.requestId);
    if (input !== undefined && input.responseCapability !== "not_resumable") {
      return { type: "question", input };
    }
  }
  return { type: "elsewhere" };
}

/** As the composer offers them when the provider names none. */
const DEFAULT_APPROVAL_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "cancel",
  "decline",
  "acceptForSession",
  "accept",
];

export function approvalDecisions(
  approval: Pick<ThreadPendingApproval, "options">,
): ReadonlyArray<ProviderApprovalDecision> {
  return approval.options?.map((option) => option.decision) ?? DEFAULT_APPROVAL_DECISIONS;
}

export type CockpitPrimary =
  | { readonly action: "approve"; readonly label: string }
  | { readonly action: "submit"; readonly label: string }
  | { readonly action: "resolve"; readonly label: string }
  | { readonly action: "complete"; readonly label: string }
  | { readonly action: "openThere"; readonly label: string };

/** E, and the first button in the outcome bar. */
export function cockpitPrimary(
  card: CockpitCard,
  input: { readonly note: string; readonly hasThread: boolean },
): CockpitPrimary | null {
  switch (card.type) {
    case "loading":
      return null;
    case "approval":
      return { action: "approve", label: "Approve" };
    case "question":
      return { action: "submit", label: "Answer" };
    case "wait":
      if (card.kind === "review") {
        return { action: "resolve", label: input.note.trim() ? "Send feedback" : "Looks good" };
      }
      return { action: "resolve", label: "Done" };
    case "todo":
      return { action: "complete", label: "Done" };
    case "elsewhere":
      return input.hasThread ? { action: "openThere", label: "Open there" } : null;
  }
}

/** What a resolved wait tells the agent. */
export function waitResolveNote(
  kind: OrchestrationV2ThreadWaitKind,
  note: string,
  option?: string,
): string | undefined {
  if (option !== undefined)
    return note.trim() ? `Chose: ${option}\n\n${note.trim()}` : `Chose: ${option}`;
  if (note.trim()) return note.trim();
  return kind === "review" ? "Looks good." : undefined;
}

/** The card's commands that do something right now, for the footer hints and the key sheet. */
export function cockpitCardCommands(
  card: CockpitCard,
  input: { readonly hasThread: boolean; readonly hasLinks: boolean; readonly hasReply: boolean },
): ReadonlyArray<CockpitKeybindingCommand> {
  const commands: CockpitKeybindingCommand[] = [];
  if (cockpitPrimary(card, { note: "", hasThread: input.hasThread }) !== null) {
    commands.push("cockpit.primary");
  }
  if (card.type === "approval") {
    commands.push("cockpit.approve");
    if (approvalDecisions(card.approval).includes("acceptForSession")) {
      commands.push("cockpit.approveForThread");
    }
    commands.push("cockpit.deny");
  }
  if (card.type !== "loading") commands.push("cockpit.snooze");
  if (input.hasThread) commands.push("cockpit.openThere");
  if (input.hasReply) commands.push("cockpit.reply");
  if (input.hasLinks) commands.push("cockpit.openLink");
  return commands;
}

const MARKDOWN_LINK =
  /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>()\]]+)/g;

/** Links in a task's detail, in reading order, for L. */
export function detailLinks(markdown: string | null | undefined): ReadonlyArray<string> {
  if (!markdown) return [];
  const links: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? "").replace(/[.,;:!?'"]+$/, "");
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

const MARKDOWN_SYNTAX = /[`*_[\]()#>|~<\\!]/;

/**
 * A run of the message as it renders, for a citation that scrolls to it: the first stretch
 * free of Markdown syntax, at most 120 characters. Null when nothing plain is long enough.
 */
export function citationQuote(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    // List markers do not render as text.
    for (const part of line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "").split(MARKDOWN_SYNTAX)) {
      const text = part.trim().replace(/\s+/g, " ");
      if (text.length < 20) continue;
      if (text.length <= 120) return text;
      const cut = text.slice(0, 120);
      const space = cut.lastIndexOf(" ");
      return space > 40 ? cut.slice(0, space) : cut;
    }
  }
  return null;
}
