import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  compileThreadCategoryRules,
  resolveThreadCategoryIds,
  threadCategoryLabel,
} from "@t3tools/shared/threadCategories";
import type {
  OrchestrationV2ThreadCategories,
  ThreadCategory,
  ThreadCategoryRule,
  ThreadCategoryView,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ChevronRightIcon,
  EllipsisIcon,
  GripVerticalIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import {
  readThreadCategories,
  readThreadCategoryViews,
  useThreadCategories,
  useThreadCategoriesEditable,
  useThreadCategoryViews,
} from "../../threadCategories";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { CategorySwatch } from "../CategorySwatch";
import { openSidebarViewEditor } from "../SidebarViewDialog";
import { openNewThreadCategoryDialog } from "../ThreadCategoryDialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from "../ui/combobox";
import { DraftInput } from "../ui/draft-input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_RULE: ThreadCategoryRule = {
  repositories: [],
  environments: [],
  providerInstances: [],
  branches: [],
  workspacePaths: [],
  projects: [],
};

type GlobField = "repositories" | "branches" | "workspacePaths";
type ChoiceField = "environments" | "providerInstances";

const GLOB_FIELDS: ReadonlyArray<{ field: GlobField; label: string; placeholder: string }> = [
  { field: "repositories", label: "Repositories", placeholder: "github.com/acme/*" },
  { field: "branches", label: "Branches", placeholder: "acme/*" },
  { field: "workspacePaths", label: "Workspace paths", placeholder: "*/work/*" },
];

interface Choice {
  readonly value: string;
  readonly label: string;
}

function parseList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The last concrete segment of a glob, so `*\/development/lego/*` reads as `lego`. */
function globLabel(glob: string): string | null {
  return (
    glob
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "*")
      .at(-1) ?? null
  );
}

function ruleSummary(
  category: ThreadCategory,
  labelFor: (field: ChoiceField, value: string) => string,
): string {
  const parts = new Set<string>();
  for (const rule of category.rules) {
    for (const project of rule.projects) parts.add(project);
    for (const glob of [...rule.workspacePaths, ...rule.repositories]) {
      const label = globLabel(glob);
      if (label !== null) parts.add(label);
    }
    for (const branch of rule.branches) parts.add(`branch ${branch}`);
    for (const value of rule.environments) parts.add(labelFor("environments", value));
    for (const value of rule.providerInstances) parts.add(labelFor("providerInstances", value));
  }
  return parts.size === 0 ? "Tagged by hand" : [...parts].join(", ");
}

function moveId(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= ids.length) return [...ids];
  return arrayMove([...ids], index, target);
}

function reorderBy<T extends { readonly id: string }>(items: readonly T[], ids: readonly string[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);
  // Items another device added since the drag started keep their place at the end.
  return [...ordered, ...items.filter((item) => !ids.includes(item.id))];
}

/** Shows a dropped order until the servers echo it back, so rows do not snap back mid-save. */
function usePendingOrder(ids: readonly string[]) {
  const key = ids.join("\n");
  const [pending, setPending] = useState<{ base: string; order: readonly string[] } | null>(null);
  // Any new server order, saved or not, retires the pending one so it cannot resurface later.
  if (pending !== null && pending.base !== key) setPending(null);
  const order = pending !== null && pending.base === key ? pending.order : ids;
  return [order, (next: readonly string[]) => setPending({ base: key, order: next })] as const;
}

function SortableList(props: {
  ids: readonly string[];
  label: string;
  onReorder: (ids: string[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    props.onReorder(
      arrayMove(
        [...props.ids],
        props.ids.indexOf(String(event.active.id)),
        props.ids.indexOf(String(event.over.id)),
      ),
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={[...props.ids]} strategy={verticalListSortingStrategy}>
        <ol aria-label={props.label} className="mt-2 mb-2 flex flex-col gap-1.5">
          {props.children}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow(props: {
  id: string;
  label: string;
  disabled: boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id, disabled: props.disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "rounded-lg border border-border/60 bg-background",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      {props.children(
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={props.disabled}
          aria-label={`Reorder ${props.label}`}
          className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>,
      )}
    </li>
  );
}

function ChoiceMenu(props: {
  label: string;
  anyLabel: string;
  choices: readonly Choice[];
  selected: readonly string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
}) {
  // Values saved on another device or for a disconnected environment stay
  // listed so they can still be unchecked.
  const choices = [
    ...props.choices,
    ...props.selected
      .filter((value) => !props.choices.some((choice) => choice.value === value))
      .map((value) => ({ value, label: value })),
  ];
  const summary =
    props.selected.length === 0
      ? props.anyLabel
      : props.selected
          .map((value) => choices.find((choice) => choice.value === value)?.label ?? value)
          .join(", ");
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={props.disabled}
            aria-label={props.label}
          />
        }
      >
        <span className="truncate">{summary}</span>
      </MenuTrigger>
      <MenuPopup align="start">
        {choices.length === 0 ? <MenuItem disabled>Nothing connected yet</MenuItem> : null}
        {choices.map((choice) => (
          <MenuCheckboxItem
            key={choice.value}
            checked={props.selected.includes(choice.value)}
            onCheckedChange={(checked) =>
              props.onChange(
                checked
                  ? [...props.selected, choice.value]
                  : props.selected.filter((value) => value !== choice.value),
              )
            }
          >
            {choice.label}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** Type a project's name to pick it; names no connected machine has can still be added. */
function ProjectsField(props: {
  choices: readonly string[];
  selected: readonly string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const taken = (name: string) =>
    props.selected.some((chosen) => chosen.toLowerCase() === name.toLowerCase());
  // Chosen names leave the list, so Enter on a highlighted match never unpicks one.
  const offered = props.choices.filter((name) => !taken(name));
  const isNew =
    typed.length > 0 &&
    !taken(typed) &&
    !offered.some((name) => name.toLowerCase() === typed.toLowerCase());
  return (
    <Combobox
      multiple
      autoHighlight
      items={isNew ? [...offered, typed] : offered}
      value={[...props.selected]}
      onValueChange={(selected: string[]) => props.onChange(selected)}
      inputValue={query}
      onInputValueChange={setQuery}
      disabled={props.disabled}
    >
      <ComboboxChips>
        <ComboboxValue>
          {(selected: string[]) =>
            selected.map((name) => <ComboboxChip key={name}>{name}</ComboboxChip>)
          }
        </ComboboxValue>
        <ComboboxChipsInput
          aria-label="Projects"
          placeholder={props.selected.length === 0 ? "Any project" : undefined}
        />
      </ComboboxChips>
      <ComboboxPopup>
        <ComboboxEmpty>
          {typed.length > 0
            ? "Already chosen"
            : props.choices.length === 0
              ? "Type a project name"
              : "Every project is chosen"}
        </ComboboxEmpty>
        <ComboboxList>
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              {isNew && name === typed ? `Add “${name}”` : name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function ThreadCategoriesSetting() {
  const categories = useThreadCategories();
  const updateSettings = useUpdatePrimarySettings();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const editable = useThreadCategoriesEditable();

  const choicesByField: Record<ChoiceField, readonly Choice[]> = {
    environments: environments.map((environment) => ({
      value: environment.environmentId,
      label: environment.label,
    })),
    providerInstances: (() => {
      const choices = new Map<string, string>();
      for (const config of serverConfigs.values()) {
        for (const provider of config.providers) {
          if (!choices.has(provider.instanceId)) {
            choices.set(provider.instanceId, provider.displayName ?? provider.instanceId);
          }
        }
      }
      return [...choices].map(([value, label]) => ({ value, label }));
    })(),
  };
  const projectNames = [
    ...new Set(
      projects.filter((project) => project.archivedAt == null).map((project) => project.title),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
  // A disconnected environment's id is unreadable, so its summary names a short prefix.
  const labelFor = (field: ChoiceField, value: string) =>
    choicesByField[field].find((choice) => choice.value === value)?.label ??
    (field === "environments" ? `machine ${value.slice(0, 8)}` : value);

  const matchCategories = compileThreadCategoryRules(categories);
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  // Thread shells change on every status or title update; only the fields
  // membership reads should trigger a recount while this page is open.
  const subjectsKey = JSON.stringify(
    threads
      .filter(
        (thread) =>
          thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent",
      )
      .map((thread) => [
        thread.environmentId,
        thread.projectId,
        thread.providerInstanceId,
        thread.branch,
        thread.categories ?? null,
      ]),
  );
  const threadCountByCategoryId = (() => {
    const counts = new Map<string, number>();
    const subjects = JSON.parse(subjectsKey) as ReadonlyArray<
      readonly [string, string, string, string | null, OrchestrationV2ThreadCategories | null]
    >;
    for (const [environmentId, projectId, providerInstanceId, branch, state] of subjects) {
      const categoryIds = resolveThreadCategoryIds(
        categories,
        matchCategories({
          environmentId,
          providerInstanceId,
          branch,
          project: projectByKey.get(`${environmentId}:${projectId}`) ?? null,
        }),
        state,
      );
      for (const id of categoryIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  })();

  // Edits start from the latest list the servers reported rather than the
  // rendered one, and write it to every connected environment.
  const writeCategories = (update: (current: readonly ThreadCategory[]) => ThreadCategory[]) => {
    if (!editable) return;
    updateSettings({ threadCategories: update(readThreadCategories()) });
  };
  const updateCategory = (
    categoryId: string,
    update: (category: ThreadCategory) => ThreadCategory,
  ) =>
    writeCategories((current) =>
      current.map((category) => (category.id === categoryId ? update(category) : category)),
    );
  const [order, setPendingOrder] = usePendingOrder(categories.map((category) => category.id));
  const reorder = (ids: readonly string[]) => {
    setPendingOrder(ids);
    writeCategories((current) => reorderBy(current, ids));
  };
  const remove = async (category: ThreadCategory) => {
    const count = threadCountByCategoryId.get(category.id) ?? 0;
    const confirmed = await requestConfirmDialog(
      `Delete ${threadCategoryLabel(category)}?${count > 0 ? `\n${count === 1 ? "1 thread loses" : `${count} threads lose`} this category.` : ""}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    writeCategories((current) => current.filter((candidate) => candidate.id !== category.id));
  };

  const ordered = reorderBy(categories, order);

  return (
    <SettingsRow
      {...searchableSetting("thread-categories")}
      description={
        editable
          ? "Group threads to filter the sidebar by. Tag a thread from its Categories menu, or add rules to file threads automatically. Drag to reorder."
          : "Group threads into categories. Connect to a server that supports thread categories to create them."
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!editable}
          onClick={openNewThreadCategoryDialog}
        >
          <PlusIcon />
          New category
        </Button>
      }
    >
      {ordered.length > 0 ? (
        <SortableList ids={order} label="Thread categories, in sidebar order" onReorder={reorder}>
          {ordered.map((category, index) => (
            <CategoryRow
              key={category.id}
              category={category}
              summary={ruleSummary(category, labelFor)}
              threadCount={threadCountByCategoryId.get(category.id) ?? 0}
              editable={editable}
              isFirst={index === 0}
              isLast={index === ordered.length - 1}
              choicesByField={choicesByField}
              projectNames={projectNames}
              onUpdate={(update) => updateCategory(category.id, update)}
              onMove={(offset) => reorder(moveId(order, category.id, offset))}
              onDelete={() => void remove(category)}
            />
          ))}
        </SortableList>
      ) : null}
    </SettingsRow>
  );
}

function CategoryRow(props: {
  category: ThreadCategory;
  summary: string;
  threadCount: number;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  choicesByField: Record<ChoiceField, readonly Choice[]>;
  projectNames: readonly string[];
  onUpdate: (update: (category: ThreadCategory) => ThreadCategory) => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { category, editable, onUpdate } = props;
  const label = threadCategoryLabel(category);
  const updateRule = (ruleIndex: number, patch: Partial<ThreadCategoryRule>) =>
    onUpdate((current) => ({
      ...current,
      rules: current.rules.map((rule, index) =>
        index === ruleIndex ? { ...rule, ...patch } : rule,
      ),
    }));

  return (
    <SortableRow id={category.id} label={label} disabled={!editable}>
      {(handle) => (
        <Collapsible>
          <div className="flex items-center gap-1 py-1 pr-2 pl-1">
            {handle}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={!editable}
                    aria-label={`Color for ${label}`}
                  />
                }
              >
                <CategorySwatch color={category.color} className="size-3" />
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuRadioGroup
                  value={category.color}
                  onValueChange={(color: ThreadCategory["color"]) =>
                    onUpdate((current) => ({ ...current, color }))
                  }
                >
                  {PROJECT_ICON_COLORS.map((color) => (
                    <MenuRadioItem key={color.value} value={color.value}>
                      <CategorySwatch color={color.value} className="size-3" />
                      {color.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
              <span className="shrink-0 text-sm font-medium">{label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {props.summary}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {props.threadCount === 1 ? "1 thread" : `${props.threadCount} threads`}
              </span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
            </CollapsibleTrigger>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!editable}
                    aria-label={`Actions for ${label}`}
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem disabled={props.isFirst} onClick={() => props.onMove(-1)}>
                  Move up
                </MenuItem>
                <MenuItem disabled={props.isLast} onClick={() => props.onMove(1)}>
                  Move down
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={props.onDelete}>
                  Delete category…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
          <CollapsiblePanel>
            <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Name</span>
                <DraftInput
                  nativeInput
                  size="sm"
                  disabled={!editable}
                  value={category.name}
                  onCommit={(name) => onUpdate((current) => ({ ...current, name }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">What belongs here, for suggestions</span>
                <DraftInput
                  nativeInput
                  size="sm"
                  placeholder="Skool, content creation"
                  disabled={!editable}
                  value={category.description}
                  onCommit={(description) => onUpdate((current) => ({ ...current, description }))}
                />
              </label>
            </div>
            {category.rules.map((rule, ruleIndex) => (
              // Rules have no identity of their own; their position is their key.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={ruleIndex} className="border-t border-border/60 px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {ruleIndex === 0 ? "Threads matching all of" : "Or threads matching all of"}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!editable}
                    aria-label="Remove rule"
                    onClick={() =>
                      onUpdate((current) => ({
                        ...current,
                        rules: current.rules.filter((_, index) => index !== ruleIndex),
                      }))
                    }
                  >
                    <XIcon />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="flex flex-col gap-1 text-xs sm:col-span-2">
                    <span className="text-muted-foreground">Projects</span>
                    <ProjectsField
                      choices={props.projectNames}
                      selected={rule.projects}
                      disabled={!editable}
                      onChange={(projects) => updateRule(ruleIndex, { projects })}
                    />
                  </div>
                  {GLOB_FIELDS.map(({ field, label: fieldLabel, placeholder }) => (
                    <label key={field} className="flex flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">{fieldLabel}</span>
                      <DraftInput
                        nativeInput
                        size="sm"
                        disabled={!editable}
                        placeholder={placeholder}
                        value={rule[field].join(", ")}
                        onCommit={(text) => updateRule(ruleIndex, { [field]: parseList(text) })}
                      />
                    </label>
                  ))}
                  {(
                    [
                      ["environments", "Environments", "Any environment"],
                      ["providerInstances", "Providers", "Any provider"],
                    ] as const satisfies ReadonlyArray<readonly [ChoiceField, string, string]>
                  ).map(([field, fieldLabel, anyLabel]) => (
                    <div key={field} className="flex flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">{fieldLabel}</span>
                      <ChoiceMenu
                        label={fieldLabel}
                        anyLabel={anyLabel}
                        choices={props.choicesByField[field]}
                        selected={rule[field]}
                        disabled={!editable}
                        onChange={(selected) => updateRule(ruleIndex, { [field]: selected })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="border-t border-border/60 px-3 py-1.5">
              <Button
                size="xs"
                variant="ghost"
                disabled={!editable}
                onClick={() =>
                  onUpdate((current) => ({ ...current, rules: [...current.rules, EMPTY_RULE] }))
                }
              >
                <PlusIcon />
                {category.rules.length === 0 ? "Add rule" : "Add another rule"}
              </Button>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </SortableRow>
  );
}

export function ThreadCategoryViewsSetting() {
  const categories = useThreadCategories();
  const views = useThreadCategoryViews();
  const updateSettings = useUpdatePrimarySettings();
  // Leftover views stay editable and deletable after their categories are gone.
  const editable = useThreadCategoriesEditable();

  const writeViews = (update: (current: readonly ThreadCategoryView[]) => ThreadCategoryView[]) => {
    if (!editable) return;
    updateSettings({ threadCategoryViews: update(readThreadCategoryViews()) });
  };
  const [order, setPendingOrder] = usePendingOrder(views.map((view) => view.id));
  const reorder = (ids: readonly string[]) => {
    setPendingOrder(ids);
    writeViews((current) => reorderBy(current, ids));
  };
  const remove = async (view: ThreadCategoryView) => {
    const confirmed = await requestConfirmDialog(`Delete the ${view.name} view?`, {
      variant: "destructive",
    });
    if (confirmed !== true) return;
    writeViews((current) => current.filter((candidate) => candidate.id !== view.id));
  };
  const ordered = reorderBy(views, order);

  return (
    <SettingsRow
      {...searchableSetting("thread-category-views")}
      description={
        categories.length === 0
          ? "Views show several categories at once. Create a category first."
          : "Views show threads from several categories at once, and can leave categories out. The sidebar's next-category shortcut steps through them in this order."
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!editable || categories.length === 0}
          onClick={() => openSidebarViewEditor()}
        >
          <PlusIcon />
          New view
        </Button>
      }
    >
      {ordered.length > 0 ? (
        <SortableList ids={order} label="Sidebar views, in shortcut order" onReorder={reorder}>
          {ordered.map((view, index) => (
            <ViewRow
              key={view.id}
              view={view}
              categories={categories}
              editable={editable}
              isFirst={index === 0}
              isLast={index === ordered.length - 1}
              onMove={(offset) => reorder(moveId(order, view.id, offset))}
              onDelete={() => void remove(view)}
            />
          ))}
        </SortableList>
      ) : null}
    </SettingsRow>
  );
}

function ViewRow(props: {
  view: ThreadCategoryView;
  categories: readonly ThreadCategory[];
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { view } = props;
  const members = props.categories.filter((category) => view.categoryIds.includes(category.id));
  const excluded = props.categories.filter((category) =>
    view.excludedCategoryIds.includes(category.id),
  );
  return (
    <SortableRow id={view.id} label={view.name} disabled={!props.editable}>
      {(handle) => (
        <div className="flex items-center gap-1 py-1 pr-2 pl-1">
          {handle}
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            <LayersIcon className="size-3.5" />
          </span>
          <button
            type="button"
            disabled={!props.editable}
            onClick={() => openSidebarViewEditor(view.id)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
          >
            <span className="shrink-0 text-sm font-medium">{view.name}</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-muted-foreground">
              {members.map((category) => (
                <span key={category.id} className="flex shrink-0 items-center gap-1">
                  <CategorySwatch color={category.color} className="size-2.5" />
                  {threadCategoryLabel(category)}
                </span>
              ))}
              {excluded.length > 0 ? (
                <span className="shrink-0">
                  {members.length > 0 ? "but not" : "Everything but"}
                </span>
              ) : null}
              {excluded.map((category) => (
                <span key={category.id} className="flex shrink-0 items-center gap-1">
                  <CategorySwatch color={category.color} className="size-2.5" />
                  {threadCategoryLabel(category)}
                </span>
              ))}
            </span>
            <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={!props.editable}
                  aria-label={`Actions for ${view.name}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={props.isFirst} onClick={() => props.onMove(-1)}>
                Move up
              </MenuItem>
              <MenuItem disabled={props.isLast} onClick={() => props.onMove(1)}>
                Move down
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={props.onDelete}>
                Delete view…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </SortableRow>
  );
}
