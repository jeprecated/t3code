import type { CockpitItem } from "@t3tools/client-runtime/state/cockpit-queue";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { COCKPIT_KINDS } from "../../cockpitKinds";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";

const ROW_CLASS_NAME =
  "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The queue after the current task; snoozed tasks fold away at the bottom. */
export function CockpitUpNext({
  regionRef,
  ...props
}: {
  readonly regionRef: Ref<HTMLDivElement>;
  readonly next: ReadonlyArray<CockpitItem>;
  readonly snoozed: ReadonlyArray<CockpitItem>;
  readonly snoozedExpanded: boolean;
  readonly nowMs: number;
  readonly onToggleSnoozed: () => void;
  readonly onSelect: (item: CockpitItem) => void;
  readonly onUnsnooze: (item: CockpitItem) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <div
      ref={regionRef}
      data-cockpit-region="upNext"
      aria-label="Up next"
      className="flex min-h-0 flex-col overflow-y-auto border-b p-2"
    >
      <h3 className="flex items-baseline gap-1.5 px-2 pb-1 text-xs font-semibold text-muted-foreground">
        Up next <span className="font-normal tabular-nums">{props.next.length}</span>
      </h3>
      {props.next.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Nothing else waits on you.</p>
      ) : null}
      <ul className="flex flex-col gap-px">
        {props.next.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              data-roving
              data-cockpit-item={item.key}
              className={ROW_CLASS_NAME}
              onClick={() => props.onSelect(item)}
            >
              <RowTitle
                item={item}
                right={
                  item.todo !== null ? null : (
                    <>
                      {item.working ? null : (
                        <LockIcon aria-label="Agent idle" className="size-3" />
                      )}
                      {formatElapsedDurationLabel(item.since, props.nowMs)}
                    </>
                  )
                }
              />
              <RowContext item={item} />
            </button>
          </li>
        ))}
      </ul>
      {props.snoozed.length > 0 ? (
        <>
          <button
            type="button"
            data-roving
            aria-expanded={props.snoozedExpanded}
            className="mt-2 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={props.onToggleSnoozed}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3", props.snoozedExpanded && "rotate-90")}
            />
            Snoozed <span className="tabular-nums">{props.snoozed.length}</span>
          </button>
          {props.snoozedExpanded ? (
            <ul className="flex flex-col gap-px">
              {props.snoozed.map((item) => (
                <li key={item.key} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    data-roving
                    data-cockpit-item={item.key}
                    className={cn(ROW_CLASS_NAME, "opacity-70")}
                    onClick={() => props.onSelect(item)}
                  >
                    <RowTitle
                      item={item}
                      right={
                        item.until === null
                          ? null
                          : `until ${formatUpcomingTimestamp(item.until, timestampFormat)}`
                      }
                    />
                    <RowContext item={item} />
                  </button>
                  {item.snoozedBy === "task" ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      data-roving
                      onClick={() => props.onUnsnooze(item)}
                    >
                      Unsnooze
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function RowTitle(props: { readonly item: CockpitItem; readonly right: ReactNode }) {
  const { icon: Icon, label, className } = COCKPIT_KINDS[props.item.kind];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon aria-label={label} className={cn("size-3.5 shrink-0", className)} />
      <span className="min-w-0 flex-1 truncate text-sm">{props.item.title}</span>
      {props.right ? (
        <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
          {props.right}
        </span>
      ) : null}
    </span>
  );
}

function RowContext(props: { readonly item: CockpitItem }) {
  const { item } = props;
  const context =
    item.todo !== null
      ? (item.where ?? "Your todo")
      : [item.projectTitle, item.threadTitle].filter(Boolean).join(" · ");
  if (!context) return null;
  return <span className="truncate ps-5 text-xs text-muted-foreground">{context}</span>;
}
