import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import { BotIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { COCKPIT_KINDS } from "../../cockpitKinds";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { OVERVIEW_ENTRY } from "./cockpit.logic";
import { useOverviewStatus, type OverviewStatus } from "./CockpitOverview";

const OVERVIEW_STATUS: Record<
  OverviewStatus,
  { readonly label: string; readonly className: string }
> = {
  notStarted: { label: "Not started", className: "text-secondary-label" },
  working: { label: "Working", className: "text-info-foreground" },
  unread: { label: "New reply", className: "font-medium text-foreground" },
  idle: { label: "Idle", className: "text-secondary-label" },
};

/** Every entry in a stable order, like the thread sidebar: the overview, then tasks, then snoozed. */
export function CockpitList(props: {
  readonly now: ReadonlyArray<CockpitItem>;
  readonly snoozed: ReadonlyArray<CockpitItem>;
  readonly snoozedExpanded: boolean;
  readonly selectedKey: string;
  readonly nowMs: number;
  readonly onToggleSnoozed: () => void;
  readonly onSelect: (key: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const overviewStatus = OVERVIEW_STATUS[useOverviewStatus()];
  const row = (key: string, children: ReactNode) => (
    <li key={key}>
      <ListRow
        entryKey={key}
        selected={key === props.selectedKey}
        onSelect={() => props.onSelect(key)}
      >
        {children}
      </ListRow>
    </li>
  );
  return (
    <nav
      data-cockpit-region="list"
      aria-label="Cockpit entries"
      className="flex min-h-0 flex-col overflow-y-auto border-e bg-sidebar p-2 text-sidebar-foreground"
    >
      <ul className="flex flex-col gap-px">
        {row(
          OVERVIEW_ENTRY,
          <>
            <RowTitle icon={<BotIcon aria-hidden className="size-3.5 shrink-0" />}>
              Overview agent
            </RowTitle>
            <RowMeta>
              <span className={overviewStatus.className}>{overviewStatus.label}</span>
            </RowMeta>
          </>,
        )}
      </ul>
      <h3 className="flex h-8 items-center px-2 text-xs font-medium text-sidebar-muted-foreground">
        Waiting on you
      </h3>
      {props.now.length === 0 ? (
        <p className="px-2 py-1 text-xs text-secondary-label">Nothing is waiting on you.</p>
      ) : null}
      <ul className="flex flex-col gap-px">
        {props.now.map((item) =>
          row(
            item.key,
            <TaskRow
              item={item}
              right={
                item.todo !== null ? null : (
                  <>
                    {item.working ? null : <LockIcon aria-label="Agent idle" className="size-3" />}
                    {formatElapsedDurationLabel(item.since, props.nowMs)}
                  </>
                )
              }
            />,
          ),
        )}
      </ul>
      {props.snoozed.length > 0 ? (
        <>
          <div className="mt-2">
            <CollapsibleSectionHeader
              data-roving
              tabIndex={-1}
              expanded={props.snoozedExpanded}
              accessory={
                <span className="text-xs tabular-nums text-sidebar-muted-foreground">
                  {props.snoozed.length}
                </span>
              }
              onClick={props.onToggleSnoozed}
            >
              Snoozed
            </CollapsibleSectionHeader>
          </div>
          {props.snoozedExpanded ? (
            <ul className="flex flex-col gap-px">
              {props.snoozed.map((item) =>
                row(
                  item.key,
                  <TaskRow
                    item={item}
                    right={
                      item.until === null
                        ? null
                        : `until ${formatUpcomingTimestamp(item.until, timestampFormat)}`
                    }
                  />,
                ),
              )}
            </ul>
          ) : null}
        </>
      ) : null}
    </nav>
  );
}

/** The sidebar's thread row surface, so the cockpit's list reads like it. */
function ListRow(props: {
  readonly entryKey: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-roving
      data-cockpit-row={props.entryKey}
      tabIndex={props.selected ? 0 : -1}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col justify-center rounded-md px-2.5 py-1.5 text-start outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected
          ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
          : "text-sidebar-foreground hover:bg-sidebar-row-hover",
      )}
      onClick={props.onSelect}
      onFocus={props.onSelect}
    >
      {props.children}
    </button>
  );
}

function RowTitle(props: {
  readonly icon: ReactNode;
  readonly right?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span className="flex h-6 min-w-0 items-center gap-2">
      {props.icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.children}</span>
      {props.right ? (
        <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-secondary-label">
          {props.right}
        </span>
      ) : null}
    </span>
  );
}

function RowMeta(props: { readonly children: ReactNode }) {
  return <span className="truncate ps-5.5 text-xs text-secondary-label">{props.children}</span>;
}

function TaskRow(props: { readonly item: CockpitItem; readonly right: ReactNode }) {
  const { item } = props;
  const { icon: Icon, label, className } = COCKPIT_KINDS[item.kind];
  const context =
    item.todo !== null
      ? (item.where ?? "Your todo")
      : [item.projectTitle, item.threadTitle].filter(Boolean).join(" · ");
  return (
    <>
      <RowTitle
        icon={<Icon aria-label={label} className={cn("size-3.5 shrink-0", className)} />}
        right={props.right}
      >
        {item.title}
      </RowTitle>
      {context ? <RowMeta>{context}</RowMeta> : null}
    </>
  );
}
