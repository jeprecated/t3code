import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { backgroundWorkNowItem } from "./ThreadActivityBanners";

const command: OrchestrationV2PendingBackgroundTask = {
  taskId: "command-1",
  kind: "command",
  description: "Dev server",
  command: "pnpm dev",
  itemId: TurnItemId.make("command-item-1"),
};

function subagent(id: string, description: string): OrchestrationV2PendingBackgroundTask {
  return {
    taskId: id,
    kind: "subagent",
    description,
    childThreadId: ThreadId.make(`child-${id}`),
  };
}

function subagentItem(id: string, progress: string, updatedAt: string) {
  return {
    id,
    type: "subagent",
    progress,
    updatedAt: DateTime.makeUnsafe(updatedAt),
  };
}

function describeBanner(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  turnItems: ReadonlyArray<ReturnType<typeof subagentItem>> = [],
): string {
  const item = backgroundWorkNowItem({
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread-1"),
    canShowOutput: (task) => task.kind === "command",
    tasks,
    turnItems: turnItems as unknown as ThreadStructure["turnItems"],
    stopDisabled: false,
    stopping: false,
    onStop: async () => {},
    onOpenThread: () => {},
  });
  return renderToStaticMarkup(<>{item?.description}</>);
}

describe("backgroundWorkNowItem", () => {
  it("keeps a command's live output beside a subagent's progress", () => {
    const html = describeBanner(
      [command, subagent("agent-1", "Explore the repo")],
      [subagentItem("agent-1", "Reading files", "2026-03-01T12:00:00.000Z")],
    );

    expect(html).toContain('aria-label="Show output of Dev server"');
    expect(html).toContain("Reading files");
  });

  it("lets each of several subagents open its own thread", () => {
    const html = describeBanner(
      [subagent("agent-1", "Explore the repo"), subagent("agent-2", "Review the diff")],
      [
        subagentItem("agent-1", "Reading files", "2026-03-01T12:00:00.000Z"),
        subagentItem("agent-2", "Checking tests", "2026-03-01T12:01:00.000Z"),
      ],
    );

    expect(html).toContain('aria-label="Open subagent Explore the repo"');
    expect(html).toContain('aria-label="Open subagent Review the diff"');
    // Only the newest progress shows, beside its own task.
    expect(html).toContain("Checking tests");
    expect(html).not.toContain("Reading files");
  });
});
