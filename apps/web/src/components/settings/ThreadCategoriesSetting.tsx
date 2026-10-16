import {
  compileThreadCategoryRules,
  resolveThreadCategoryIds,
  threadCategoryLabel,
} from "@t3tools/shared/threadCategories";
import type {
  OrchestrationV2ThreadCategories,
  ThreadCategory,
  ThreadCategoryRule,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { EllipsisIcon, PlusIcon, XIcon } from "lucide-react";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn, randomUUID } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import {
  environmentSupportsThreadCategories,
  readThreadCategories,
  useThreadCategories,
} from "../../threadCategories";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { CategorySwatch } from "../CategorySwatch";
import { Button } from "../ui/button";
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

function nextColor(categories: readonly ThreadCategory[]): ThreadCategory["color"] {
  const used = new Set(categories.map((category) => category.color));
  const palette = PROJECT_ICON_COLORS.filter((color) => color.value !== "gray");
  return (palette.find((color) => !used.has(color.value)) ?? palette[0]!).value;
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

export function ThreadCategoriesSetting() {
  const categories = useThreadCategories();
  const updateSettings = useUpdatePrimarySettings();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const editable = [...serverConfigs.values()].some(environmentSupportsThreadCategories);

  const environmentChoices = environments.map((environment): Choice => ({
    value: environment.environmentId,
    label: environment.label,
  }));
  const providerChoices = (() => {
    const choices = new Map<string, string>();
    for (const config of serverConfigs.values()) {
      for (const provider of config.providers) {
        if (!choices.has(provider.instanceId)) {
          choices.set(provider.instanceId, provider.displayName ?? provider.instanceId);
        }
      }
    }
    return [...choices].map(([value, label]): Choice => ({ value, label }));
  })();

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
  const updateRule = (categoryId: string, ruleIndex: number, patch: Partial<ThreadCategoryRule>) =>
    updateCategory(categoryId, (category) => ({
      ...category,
      rules: category.rules.map((rule, index) =>
        index === ruleIndex ? { ...rule, ...patch } : rule,
      ),
    }));
  const moveCategory = (categoryId: string, offset: -1 | 1) =>
    writeCategories((current) => {
      const index = current.findIndex((category) => category.id === categoryId);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= current.length) return [...current];
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  return (
    <SettingsRow
      {...searchableSetting("thread-categories")}
      description={
        editable
          ? "Group threads by repository, environment, provider, branch, or path. Pick a category in the sidebar filter to show only its threads; every thread is marked with the colors of its categories. A thread's Categories menu, or an agent, adds it to or takes it out of a category on its own, and new threads suggest the categories that fit. Categories are saved on every connected environment."
          : "Group threads into categories. Connect to a server that supports thread categories to create them."
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!editable}
          onClick={() =>
            writeCategories((current) => [
              ...current,
              {
                id: randomUUID(),
                name: "New category",
                description: "",
                color: nextColor(current),
                rules: [EMPTY_RULE],
              },
            ])
          }
        >
          <PlusIcon />
          Add category
        </Button>
      }
    >
      {categories.length > 0 ? (
        <div className="mt-2 mb-2 flex flex-col gap-3">
          {categories.map((category, categoryIndex) => {
            const matchCount = threadCountByCategoryId.get(category.id) ?? 0;
            return (
              <div key={category.id} className="rounded-lg border border-border/60">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={!editable}
                          aria-label={`Color for ${threadCategoryLabel(category)}`}
                        />
                      }
                    >
                      <CategorySwatch color={category.color} className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuRadioGroup
                        value={category.color}
                        onValueChange={(color: ThreadCategory["color"]) =>
                          updateCategory(category.id, (current) => ({ ...current, color }))
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
                  <DraftInput
                    nativeInput
                    size="sm"
                    className="w-full max-w-56"
                    aria-label="Category name"
                    disabled={!editable}
                    value={category.name}
                    onCommit={(name) =>
                      updateCategory(category.id, (current) => ({ ...current, name }))
                    }
                  />
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {matchCount === 1 ? "1 thread" : `${matchCount} threads`}
                  </span>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          disabled={!editable}
                          aria-label={`Actions for ${threadCategoryLabel(category)}`}
                        />
                      }
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        disabled={categoryIndex === 0}
                        onClick={() => moveCategory(category.id, -1)}
                      >
                        Move up
                      </MenuItem>
                      <MenuItem
                        disabled={categoryIndex === categories.length - 1}
                        onClick={() => moveCategory(category.id, 1)}
                      >
                        Move down
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          writeCategories((current) =>
                            current.filter((candidate) => candidate.id !== category.id),
                          )
                        }
                      >
                        Delete category
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
                <div className="px-3 pb-2">
                  <DraftInput
                    nativeInput
                    size="sm"
                    aria-label={`What belongs in ${threadCategoryLabel(category)}`}
                    placeholder="What belongs here, for suggestions (e.g. Skool, content creation)"
                    disabled={!editable}
                    value={category.description}
                    onCommit={(description) =>
                      updateCategory(category.id, (current) => ({ ...current, description }))
                    }
                  />
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
                          updateCategory(category.id, (current) => ({
                            ...current,
                            rules: current.rules.filter((_, index) => index !== ruleIndex),
                          }))
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {GLOB_FIELDS.map(({ field, label, placeholder }) => (
                        <label key={field} className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">{label}</span>
                          <DraftInput
                            nativeInput
                            size="sm"
                            disabled={!editable}
                            placeholder={placeholder}
                            value={rule[field].join(", ")}
                            onCommit={(text) =>
                              updateRule(category.id, ruleIndex, { [field]: parseList(text) })
                            }
                          />
                        </label>
                      ))}
                      {(
                        [
                          ["environments", "Environments", "Any environment", environmentChoices],
                          ["providerInstances", "Providers", "Any provider", providerChoices],
                        ] as const satisfies ReadonlyArray<
                          readonly [ChoiceField, string, string, readonly Choice[]]
                        >
                      ).map(([field, label, anyLabel, choices]) => (
                        <div key={field} className="flex flex-col gap-1 text-xs">
                          <span className="text-muted-foreground">{label}</span>
                          <ChoiceMenu
                            label={label}
                            anyLabel={anyLabel}
                            choices={choices}
                            selected={rule[field]}
                            disabled={!editable}
                            onChange={(selected) =>
                              updateRule(category.id, ruleIndex, { [field]: selected })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div
                  className={cn(
                    "px-3 py-1.5",
                    category.rules.length > 0 && "border-t border-border/60",
                  )}
                >
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!editable}
                    onClick={() =>
                      updateCategory(category.id, (current) => ({
                        ...current,
                        rules: [...current.rules, EMPTY_RULE],
                      }))
                    }
                  >
                    <PlusIcon />
                    {category.rules.length === 0 ? "Add rule" : "Add another rule"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </SettingsRow>
  );
}
