import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  youQueueTodoKey,
  youQueueTriageTarget,
  type YouQueueItem,
} from "@t3tools/client-runtime/state/you-queue";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type UserTodo } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { BotIcon, CircleDashedIcon, MapPinIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import {
  openNextYouQueueItem,
  openYouQueueItem,
  overviewThreadKeyAtom,
  useYouQueue,
  youEnvironmentIdAtom,
} from "../../youQueue";
import { YOU_QUEUE_KINDS } from "../../youQueueKinds";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Input } from "../ui/input";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarModeToggle } from "./SidebarModeToggle";

const NO_PERMISSION_ATOM = Atom.make(false).pipe(Atom.withLabel("web:you-queue:no-permission"));

type Section = "now" | "elsewhere" | "later" | "todos";
const SECTION_DEFAULTS: Record<Section, boolean> = {
  now: true,
  elsewhere: false,
  later: false,
  todos: true,
};

function useSectionExpanded(section: Section) {
  return useLocalStorage(
    `t3code:you-queue:${section}-expanded`,
    SECTION_DEFAULTS[section],
    Schema.Boolean,
  );
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return true;
}

export function YouQueueSidebar() {
  const queue = useYouQueue();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeRef = useThreadRouteRef();
  const routeThreadKey = routeRef === null ? null : scopedThreadKey(routeRef);
  const triage = useUiStateStore((state) => state.youTriage);
  const setTriage = useUiStateStore((state) => state.setYouTriage);
  const setYouNotHere = useUiStateStore((state) => state.setYouNotHere);
  const environments = useEnvironmentIdentities();
  const environmentLabels =
    environments.length > 1
      ? new Map(environments.map((environment) => [environment.environmentId, environment.label]))
      : null;
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [nowExpanded, setNowExpanded] = useSectionExpanded("now");
  const [elsewhereExpanded, setElsewhereExpanded] = useSectionExpanded("elsewhere");
  const [laterExpanded, setLaterExpanded] = useSectionExpanded("later");
  const [todosExpanded, setTodosExpanded] = useSectionExpanded("todos");
  const [editingTodoKey, setEditingTodoKey] = useState<string | null>(null);

  const open = (item: YouQueueItem) => {
    if (isMobile) setOpenMobile(false);
    openYouQueueItem(router, item);
  };

  const previousNowRef = useRef(queue.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- triage follows the queue, which changes when the server resolves an item, so it navigates once the open thread's last item leaves
  useEffect(() => {
    const previous = previousNowRef.current;
    previousNowRef.current = queue.now;
    if (!triage) return;
    const target = youQueueTriageTarget(previous, queue.now, routeThreadKey);
    if (target !== null) openYouQueueItem(router, target);
  }, [queue.now, triage, routeThreadKey, router]);

  const renderItem = (item: YouQueueItem, section: Section) => {
    const environmentLabel = environmentLabels?.get(item.environmentId) ?? null;
    const right = timingLabel(item, section, nowMs, timestampFormat);
    const onShowHere = section === "elsewhere" ? () => setYouNotHere(item.key, false) : null;
    if (item.todo !== null) {
      return (
        <TodoRow
          key={item.key}
          item={item}
          todo={item.todo}
          editing={editingTodoKey === item.key}
          onToggleEditing={() =>
            setEditingTodoKey((current) => (current === item.key ? null : item.key))
          }
          onDone={() => {
            setEditingTodoKey(null);
            if (triage) openNextYouQueueItem(router);
          }}
          environmentLabel={environmentLabel}
          right={right}
          onShowHere={onShowHere}
        />
      );
    }
    return (
      <QueueRow
        key={item.key}
        item={item}
        selected={item.threadKey === routeThreadKey}
        onOpen={() => open(item)}
        environmentLabel={environmentLabel}
        right={right}
        onShowHere={onShowHere}
      />
    );
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarModeToggle count={queue.now.length} />
            <div className="mt-1 flex h-7 items-center justify-between gap-2 ps-2 text-xs text-sidebar-muted-foreground">
              <span className="min-w-0 truncate">
                {queue.now.length === 0
                  ? "Nothing is waiting on you"
                  : `${queue.now.length} waiting on you`}
              </span>
              <Toggle
                size="xs"
                variant="ghost"
                pressed={triage}
                onPressedChange={setTriage}
                title="After you finish an item, open the next one"
              >
                Triage
              </Toggle>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          <OverviewRow
            routeThreadKey={routeThreadKey}
            onOpened={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
          <QueueSection
            label="Now"
            count={queue.now.length}
            expanded={nowExpanded}
            onToggle={() => setNowExpanded((value) => !value)}
          >
            {queue.now.map((item) => renderItem(item, "now"))}
          </QueueSection>
          {queue.elsewhere.length > 0 ? (
            <QueueSection
              label="Elsewhere"
              count={queue.elsewhere.length}
              expanded={elsewhereExpanded}
              onToggle={() => setElsewhereExpanded((value) => !value)}
            >
              {queue.elsewhere.map((item) => renderItem(item, "elsewhere"))}
            </QueueSection>
          ) : null}
          {queue.later.length > 0 ? (
            <QueueSection
              label="Later"
              count={queue.later.length}
              expanded={laterExpanded}
              onToggle={() => setLaterExpanded((value) => !value)}
            >
              {queue.later.map((item) => renderItem(item, "later"))}
            </QueueSection>
          ) : null}
          <QueueSection
            label="Your todos"
            count={queue.todos.length}
            expanded={todosExpanded}
            onToggle={() => setTodosExpanded((value) => !value)}
          >
            {queue.todos.map((item) => renderItem(item, "todos"))}
            <AddTodo />
          </QueueSection>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function timingLabel(
  item: YouQueueItem,
  section: Section,
  nowMs: number,
  timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1],
): string {
  if (section === "later" && item.notBefore !== null) {
    return formatUpcomingTimestamp(item.notBefore, timestampFormat, nowMs);
  }
  if (item.todo !== null) return "";
  // The list re-renders once a minute, so a seconds count would sit stale.
  return nowMs - Date.parse(item.since) < 60_000
    ? "<1m"
    : formatElapsedDurationLabel(item.since, nowMs);
}

function QueueSection(props: {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-1">
      <CollapsibleSectionHeader
        expanded={props.expanded}
        onClick={props.onToggle}
        accessory={<span className="shrink-0 tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
      {props.expanded ? <ul className="flex flex-col gap-px">{props.children}</ul> : null}
    </section>
  );
}

const ROW_CLASS_NAME =
  "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=true]:bg-sidebar-row-active";

function RowContext(props: {
  readonly item: YouQueueItem;
  readonly environmentLabel: string | null;
}) {
  const { item } = props;
  const context =
    item.todo !== null
      ? (item.todo.notes?.split("\n")[0] ?? null)
      : [item.projectTitle, item.threadTitle].filter(Boolean).join(" · ");
  if (!context && !item.where && !props.environmentLabel) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 ps-5 text-xs text-secondary-label">
      <span className="min-w-0 truncate">{context}</span>
      {item.where ? (
        <span className="flex min-w-0 shrink items-center gap-0.5 truncate">
          <MapPinIcon aria-hidden className="size-3 shrink-0" />
          {item.where}
        </span>
      ) : null}
      {props.environmentLabel ? (
        <span className="ms-auto shrink-0">{props.environmentLabel}</span>
      ) : null}
    </span>
  );
}

function RowTitle(props: { readonly item: YouQueueItem; readonly right: string }) {
  const { item } = props;
  const { icon: Icon, label, className } = YOU_QUEUE_KINDS[item.kind];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon aria-label={label} className={cn("size-3.5 shrink-0", className)} />
      <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">{item.title}</span>
      {item.working ? (
        <CircleDashedIcon
          aria-label="The agent is still working"
          className="size-3 shrink-0 text-info-foreground"
        />
      ) : null}
      {props.right ? (
        <span className="shrink-0 text-xs tabular-nums text-secondary-label">{props.right}</span>
      ) : null}
    </span>
  );
}

function ShowHereButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label="Show here again"
      title="Show here again"
      onClick={onClick}
    >
      <MapPinIcon />
    </Button>
  );
}

function QueueRow(props: {
  readonly item: YouQueueItem;
  readonly selected: boolean;
  readonly onOpen: () => void;
  readonly environmentLabel: string | null;
  readonly right: string;
  readonly onShowHere: (() => void) | null;
}) {
  return (
    <li className="flex list-none items-center gap-0.5">
      <button
        type="button"
        aria-current={props.selected}
        className={ROW_CLASS_NAME}
        onClick={props.onOpen}
      >
        <RowTitle item={props.item} right={props.right} />
        <RowContext item={props.item} environmentLabel={props.environmentLabel} />
      </button>
      {props.onShowHere ? <ShowHereButton onClick={props.onShowHere} /> : null}
    </li>
  );
}

function TodoRow(props: {
  readonly item: YouQueueItem;
  readonly todo: UserTodo;
  readonly editing: boolean;
  readonly onToggleEditing: () => void;
  readonly onDone: () => void;
  readonly environmentLabel: string | null;
  readonly right: string;
  readonly onShowHere: (() => void) | null;
}) {
  return (
    <li className="list-none">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={props.editing}
          className={ROW_CLASS_NAME}
          onClick={props.onToggleEditing}
        >
          <RowTitle item={props.item} right={props.right} />
          <RowContext item={props.item} environmentLabel={props.environmentLabel} />
        </button>
        {props.onShowHere ? <ShowHereButton onClick={props.onShowHere} /> : null}
      </div>
      {props.editing ? (
        <TodoEditor
          environmentId={props.item.environmentId}
          todo={props.todo}
          onClose={props.onToggleEditing}
          onDone={props.onDone}
        />
      ) : null}
    </li>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `datetime-local` reads and writes local wall time. */
function toLocalInput(iso: string | undefined): string {
  if (iso === undefined) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function TodoEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly todo: UserTodo;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { environmentId, todo } = props;
  const canEdit = useAtomValue(serverEnvironment.upsertUserTodo.permissionAtom(environmentId));
  const upsert = useAtomCommand(serverEnvironment.upsertUserTodo, { reportFailure: false });
  const setCompleted = useAtomCommand(serverEnvironment.setUserTodoCompleted, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteUserTodo, { reportFailure: false });
  const notHere = useUiStateStore((state) =>
    state.youNotHereKeys.includes(youQueueTodoKey(environmentId, todo.id)),
  );
  const setYouNotHere = useUiStateStore((state) => state.setYouNotHere);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes ?? "");
  const [where, setWhere] = useState(todo.where ?? "");
  const [notBefore, setNotBefore] = useState(toLocalInput(todo.notBefore));
  const [busy, setBusy] = useState(false);

  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    return !reportFailure(title, result);
  };
  const save = async () => {
    const date = notBefore === "" ? null : new Date(notBefore);
    const saved = await run("Could not save the todo", () =>
      upsert({
        environmentId,
        input: {
          id: todo.id,
          ...(title.trim() ? { title: title.trim() } : {}),
          notes: notes.trim() || null,
          where: where.trim() || null,
          notBefore: date === null || Number.isNaN(date.getTime()) ? null : date.toISOString(),
        },
      }),
    );
    if (saved) props.onClose();
  };
  const onEnter = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void save();
  };
  const disabled = !canEdit || busy;

  return (
    <div className="flex flex-col gap-1.5 px-(--sidebar-row-content-inset) pt-1 pb-2">
      <Input
        size="compact"
        aria-label="Title"
        value={title}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onEnter}
      />
      <Textarea
        size="sm"
        aria-label="Notes"
        placeholder="Notes"
        value={notes}
        disabled={disabled}
        onChange={(event) => setNotes(event.target.value)}
      />
      <Input
        size="compact"
        aria-label="Where"
        placeholder="Where, such as: iPhone in hand"
        value={where}
        disabled={disabled}
        onChange={(event) => setWhere(event.target.value)}
        onKeyDown={onEnter}
      />
      <Input
        size="compact"
        type="datetime-local"
        aria-label="Not before"
        value={notBefore}
        disabled={disabled}
        onChange={(event) => setNotBefore(event.target.value)}
        onKeyDown={onEnter}
      />
      <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" disabled={disabled} onClick={() => void save()}>
          Save
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={async () => {
            const done = await run("Could not complete the todo", () =>
              setCompleted({ environmentId, input: { id: todo.id, completed: true } }),
            );
            if (!done) return;
            props.onDone();
            const toastId = toastManager.add({
              type: "success",
              title: `Done: ${todo.title}`,
              actionProps: {
                children: "Undo",
                onClick: async () => {
                  toastManager.close(toastId);
                  const result = await setCompleted({
                    environmentId,
                    input: { id: todo.id, completed: false },
                  });
                  reportFailure("Could not reopen the todo", result);
                },
              },
            });
          }}
        >
          Done
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setYouNotHere(youQueueTodoKey(environmentId, todo.id), !notHere)}
        >
          {notHere ? "Show here again" : "Not here"}
        </Button>
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={disabled}
          onClick={async () => {
            const deleted = await run("Could not delete the todo", () =>
              remove({ environmentId, input: { id: todo.id } }),
            );
            if (deleted) props.onClose();
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function AddTodo() {
  const environmentId = useAtomValue(youEnvironmentIdAtom);
  const canCreate = useAtomValue(
    environmentId === null
      ? NO_PERMISSION_ATOM
      : serverEnvironment.upsertUserTodo.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertUserTodo, { reportFailure: false });
  const [title, setTitle] = useState("");
  if (environmentId === null || !canCreate) return null;
  return (
    <li className="list-none px-(--sidebar-row-content-inset) pt-1">
      <Input
        size="compact"
        aria-label="Add todo"
        placeholder="Add todo…"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={async (event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const value = title.trim();
          if (!value) return;
          setTitle("");
          const result = await upsert({ environmentId, input: { title: value } });
          if (reportFailure("Could not add the todo", result)) setTitle(value);
        }}
      />
    </li>
  );
}

function overviewStatus(
  shell: EnvironmentThreadShell,
): { readonly label: string; readonly className: string } | null {
  switch (resolveSidebarThreadStatus(shell)) {
    case "working":
      return { label: "Working", className: "text-info-foreground" };
    case "approval":
      return { label: "Approval", className: "text-warning-foreground" };
    case "input":
      return { label: "Input", className: "text-indigo-600 dark:text-indigo-300" };
    case "request":
      return { label: "Request", className: "text-guest-foreground" };
    case "failed":
      return { label: "Failed", className: "text-destructive-foreground" };
    case "limited":
      return { label: "Limited", className: "text-warning-foreground" };
    case "waiting":
      return { label: "Waiting", className: "text-secondary-label" };
    case "ready":
      return hasUnseenCompletion(shell)
        ? { label: "Done", className: "text-success-foreground" }
        : null;
  }
}

/** What a new thread on this environment would use, so the overview never falls back to an unauthenticated provider. */
function newThreadModelSelection(environmentId: EnvironmentId) {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = config?.providers ?? [];
  return settings.defaultModelSelection
    ? resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection)
    : resolveProjectDefaultProviderModelSelection(providers, settings, null);
}

function OverviewRow(props: {
  readonly routeThreadKey: string | null;
  readonly onOpened: () => void;
}) {
  const router = useRouter();
  const environmentId = useAtomValue(youEnvironmentIdAtom);
  const overviewKey = useAtomValue(overviewThreadKeyAtom);
  const shell = useQuietThreadShell(
    overviewKey === null ? null : parseScopedThreadKey(overviewKey),
  );
  const canStart = useAtomValue(
    environmentId === null
      ? NO_PERMISSION_ATOM
      : serverEnvironment.startOverview.permissionAtom(environmentId),
  );
  const start = useAtomCommand(serverEnvironment.startOverview, { reportFailure: false });
  const [starting, setStarting] = useState(false);

  if (shell !== null && shell.archivedAt === null && shell.deletedAt === null) {
    const status = overviewStatus(shell);
    return (
      <button
        type="button"
        aria-current={overviewKey === props.routeThreadKey}
        className={cn(ROW_CLASS_NAME, "mb-1")}
        onClick={() => {
          props.onOpened();
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
          });
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <BotIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
            Overview
          </span>
          {status ? (
            <span className={cn("shrink-0 text-xs", status.className)}>{status.label}</span>
          ) : null}
        </span>
      </button>
    );
  }
  if (environmentId === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canStart || starting}
      onClick={async () => {
        setStarting(true);
        const modelSelection = newThreadModelSelection(environmentId);
        const result = await start({
          environmentId,
          input: modelSelection === null ? {} : { modelSelection },
        });
        setStarting(false);
        if (reportFailure("Could not start the overview agent", result)) return;
        if (result._tag !== "Success") return;
        props.onOpened();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
        });
      }}
    >
      <BotIcon />
      {starting ? "Starting overview agent…" : "Start overview agent"}
    </Button>
  );
}
