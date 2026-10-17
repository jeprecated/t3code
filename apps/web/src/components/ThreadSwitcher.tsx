import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { sortThreads } from "~/lib/threadSort";
import { useProjects, useThreadShells } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { rankThreadSwitcherThreads } from "./ThreadSwitcher.logic";
import { Kbd, KbdGroup } from "./ui/kbd";

export function ThreadSwitcher(props: { readonly setOpen: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [includeSettled, setIncludeSettled] = useState(false);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [now] = useState(() => new Date().toISOString());
  const threads = useThreadShells();
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const currentThreadKey =
    routeTarget?.kind === "server"
      ? `${routeTarget.threadRef.environmentId}:${routeTarget.threadRef.threadId}`
      : null;

  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const ranked = rankThreadSwitcherThreads(sortThreads(threads, sortOrder), {
    query,
    includeSettled,
    now,
    currentThreadKey,
    repoOf: (thread) =>
      projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.title ?? null,
  });

  const items: CommandPaletteActionItem[] = ranked.map((thread) => {
    const threadKey = `${thread.environmentId}:${thread.id}`;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
    return {
      kind: "action",
      value: `thread:${threadKey}`,
      searchTerms: [],
      title: thread.title,
      description: (
        <ThreadCommandSubtitle
          project={project}
          projectTitle={project?.title ?? null}
          branch={thread.branch}
          worktreePath={thread.worktreePath}
          isCurrent={threadKey === currentThreadKey}
          variant="favicon-workspace"
        />
      ),
      titleLeadingContent: <ThreadRowLeadingStatus thread={thread} />,
      titleTrailingContent: <ThreadRowTrailingStatus thread={thread} />,
      timestamp: formatRelativeTimeLabel(
        thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
      ),
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      },
    };
  });

  const emptyStateMessage =
    query.trim().length > 0
      ? includeSettled
        ? "No matching threads."
        : "No matching active threads. Press Tab to include settled threads."
      : includeSettled
        ? "No threads."
        : "No active threads. Press Tab to include settled threads.";

  return (
    <CommandPaletteContent
      aria-label="Switch thread"
      autoHighlight="always"
      footerActionLabel="Open thread"
      footerTrailing={
        <KbdGroup>
          <Kbd>Tab</Kbd>
          <span>{includeSettled ? "Hide settled" : "Show settled"}</span>
        </KbdGroup>
      }
      inputProps={{
        placeholder: includeSettled ? "Search all threads…" : "Search active threads…",
        onKeyDown: (event) => {
          if (
            event.key !== "Tab" ||
            event.shiftKey ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey
          ) {
            return;
          }
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          event.preventDefault();
          setHighlightedItemValue(null);
          setIncludeSettled((current) => !current);
        },
      }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="thread-switcher"
      value={query}
    >
      <CommandPaletteResults
        groups={
          items.length > 0
            ? [
                {
                  value: "threads",
                  label: includeSettled ? "All threads" : "Active threads",
                  items,
                },
              ]
            : []
        }
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          props.setOpen(false);
          void item.run();
        }}
        emptyStateMessage={emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}
