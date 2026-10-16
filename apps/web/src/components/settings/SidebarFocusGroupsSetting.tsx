import { compileSidebarFocusGroups } from "@t3tools/client-runtime/state/sidebar-focus-groups";
import type { SidebarFocusGroup, SidebarFocusGroupRule } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { EllipsisIcon, PlusIcon, XIcon } from "lucide-react";

import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { cn, randomUUID } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { sidebarFocusGroupLabel } from "../../sidebarFocus";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { FocusGroupSwatch } from "../FocusGroupSwatch";
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

const EMPTY_RULE: SidebarFocusGroupRule = {
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

function nextColor(groups: readonly SidebarFocusGroup[]): SidebarFocusGroup["color"] {
  const used = new Set(groups.map((group) => group.color));
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

export function SidebarFocusGroupsSetting() {
  const groups = useClientSettings((settings) => settings.sidebarFocusGroups);
  const hydrated = useClientSettingsHydrated();
  const updateClientSettings = useUpdateClientSettings();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const threads = useThreadShells();

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

  const matchFocusGroups = compileSidebarFocusGroups(groups);
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  // Thread shells change on every status or title update; only the fields the
  // rules read should trigger a recount while this page is open.
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
      ]),
  );
  const matchCountByGroupId = (() => {
    const counts = new Map<string, number>();
    const subjects = JSON.parse(subjectsKey) as ReadonlyArray<
      readonly [string, string, string, string | null]
    >;
    for (const [environmentId, projectId, providerInstanceId, branch] of subjects) {
      const groupIds = matchFocusGroups({
        environmentId,
        providerInstanceId,
        branch,
        project: projectByKey.get(`${environmentId}:${projectId}`) ?? null,
      });
      for (const groupId of groupIds) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }
    return counts;
  })();

  // Edits read the live settings rather than the rendered list, so two quick
  // edits before a re-render cannot overwrite each other.
  const writeGroups = (update: (current: readonly SidebarFocusGroup[]) => SidebarFocusGroup[]) => {
    if (!hydrated) return;
    updateClientSettings({ sidebarFocusGroups: update(getClientSettings().sidebarFocusGroups) });
  };
  const updateGroup = (groupId: string, update: (group: SidebarFocusGroup) => SidebarFocusGroup) =>
    writeGroups((current) =>
      current.map((group) => (group.id === groupId ? update(group) : group)),
    );
  const updateRule = (groupId: string, ruleIndex: number, patch: Partial<SidebarFocusGroupRule>) =>
    updateGroup(groupId, (group) => ({
      ...group,
      rules: group.rules.map((rule, index) => (index === ruleIndex ? { ...rule, ...patch } : rule)),
    }));
  const moveGroup = (groupId: string, offset: -1 | 1) =>
    writeGroups((current) => {
      const index = current.findIndex((group) => group.id === groupId);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= current.length) return [...current];
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  return (
    <SettingsRow
      {...searchableSetting("sidebar-focus-groups")}
      description="Name sets of threads by repository, environment, provider, branch, or path. Pick one in the sidebar filter to show only its threads; every thread is marked with the colors of the groups it belongs to."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!hydrated}
          onClick={() =>
            writeGroups((current) => [
              ...current,
              {
                id: randomUUID(),
                name: "New group",
                color: nextColor(current),
                rules: [EMPTY_RULE],
              },
            ])
          }
        >
          <PlusIcon />
          Add group
        </Button>
      }
    >
      {groups.length > 0 ? (
        <div className="mt-2 mb-2 flex flex-col gap-3">
          {groups.map((group, groupIndex) => {
            const matchCount = matchCountByGroupId.get(group.id) ?? 0;
            return (
              <div key={group.id} className="rounded-lg border border-border/60">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={!hydrated}
                          aria-label={`Color for ${sidebarFocusGroupLabel(group)}`}
                        />
                      }
                    >
                      <FocusGroupSwatch color={group.color} className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuRadioGroup
                        value={group.color}
                        onValueChange={(color: SidebarFocusGroup["color"]) =>
                          updateGroup(group.id, (current) => ({ ...current, color }))
                        }
                      >
                        {PROJECT_ICON_COLORS.map((color) => (
                          <MenuRadioItem key={color.value} value={color.value}>
                            <FocusGroupSwatch color={color.value} className="size-3" />
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
                    aria-label="Group name"
                    disabled={!hydrated}
                    value={group.name}
                    onCommit={(name) => updateGroup(group.id, (current) => ({ ...current, name }))}
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
                          disabled={!hydrated}
                          aria-label={`Actions for ${sidebarFocusGroupLabel(group)}`}
                        />
                      }
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem disabled={groupIndex === 0} onClick={() => moveGroup(group.id, -1)}>
                        Move up
                      </MenuItem>
                      <MenuItem
                        disabled={groupIndex === groups.length - 1}
                        onClick={() => moveGroup(group.id, 1)}
                      >
                        Move down
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          writeGroups((current) =>
                            current.filter((candidate) => candidate.id !== group.id),
                          )
                        }
                      >
                        Delete group
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
                {group.rules.map((rule, ruleIndex) => (
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
                        disabled={!hydrated}
                        aria-label="Remove rule"
                        onClick={() =>
                          updateGroup(group.id, (current) => ({
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
                            disabled={!hydrated}
                            placeholder={placeholder}
                            value={rule[field].join(", ")}
                            onCommit={(text) =>
                              updateRule(group.id, ruleIndex, { [field]: parseList(text) })
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
                            disabled={!hydrated}
                            onChange={(selected) =>
                              updateRule(group.id, ruleIndex, { [field]: selected })
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
                    group.rules.length > 0 && "border-t border-border/60",
                  )}
                >
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!hydrated}
                    onClick={() =>
                      updateGroup(group.id, (current) => ({
                        ...current,
                        rules: [...current.rules, EMPTY_RULE],
                      }))
                    }
                  >
                    <PlusIcon />
                    {group.rules.length === 0 ? "Add rule" : "Add another rule"}
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
