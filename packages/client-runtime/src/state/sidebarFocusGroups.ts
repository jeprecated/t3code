import type { RepositoryIdentity, SidebarFocusGroup } from "@t3tools/contracts";

export interface SidebarFocusSubject {
  readonly environmentId: string;
  readonly providerInstanceId: string | null;
  readonly branch: string | null;
  readonly project: {
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  } | null;
}

export type SidebarFocusScope =
  | { readonly type: "group"; readonly groupId: string }
  | { readonly type: "ungrouped" };

export type SidebarFocusMatcher = (subject: SidebarFocusSubject) => readonly string[];

const NO_GROUPS: readonly string[] = [];

function compileGlobs(patterns: readonly string[]): readonly string[] {
  return patterns.map((pattern) => pattern.trim().toLowerCase()).filter((p) => p.length > 0);
}

function compileValues(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

// Greedy two-pointer match: `*` matches any run of characters. Unlike a
// `.*`-per-star regex it cannot backtrack exponentially on patterns like
// `********x`, and it runs per thread on every sidebar recompute.
function globMatches(glob: string, value: string): boolean {
  let globIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;
  while (valueIndex < value.length) {
    const char = glob[globIndex];
    if (char === "*") {
      starIndex = globIndex;
      starValueIndex = valueIndex;
      globIndex += 1;
    } else if (char === value[valueIndex]) {
      globIndex += 1;
      valueIndex += 1;
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (glob[globIndex] === "*") globIndex += 1;
  return globIndex === glob.length;
}

function anyGlobMatches(globs: readonly string[], values: readonly string[]): boolean {
  return globs.some((glob) => values.some((value) => globMatches(glob, value.toLowerCase())));
}

/**
 * A rule matches when every field it fills in matches; a group matches when
 * any of its rules does. A rule with no filled-in fields matches nothing, so a
 * freshly added rule never silently captures every thread.
 */
export function compileSidebarFocusGroups(
  groups: readonly SidebarFocusGroup[],
): SidebarFocusMatcher {
  const compiled = groups.map((group) => ({
    id: group.id,
    rules: group.rules
      .map((rule) => ({
        repositories: compileGlobs(rule.repositories),
        environments: compileValues(rule.environments),
        providerInstances: compileValues(rule.providerInstances),
        branches: compileGlobs(rule.branches),
        workspacePaths: compileGlobs(rule.workspacePaths),
      }))
      .filter(
        (rule) =>
          rule.repositories.length > 0 ||
          rule.environments.size > 0 ||
          rule.providerInstances.size > 0 ||
          rule.branches.length > 0 ||
          rule.workspacePaths.length > 0,
      ),
  }));
  if (compiled.every((group) => group.rules.length === 0)) return () => NO_GROUPS;

  return (subject) => {
    const identity = subject.project?.repositoryIdentity;
    // A fork matches by its own key or by the upstream it was forked from.
    const repositoryKeys = identity
      ? identity.origin
        ? [identity.canonicalKey, identity.origin.canonicalKey]
        : [identity.canonicalKey]
      : [];
    const workspaceRoots = subject.project ? [subject.project.workspaceRoot] : [];
    const branches = subject.branch ? [subject.branch] : [];
    const matched: string[] = [];
    for (const group of compiled) {
      const matches = group.rules.some(
        (rule) =>
          (rule.repositories.length === 0 || anyGlobMatches(rule.repositories, repositoryKeys)) &&
          (rule.environments.size === 0 || rule.environments.has(subject.environmentId)) &&
          (rule.providerInstances.size === 0 ||
            (subject.providerInstanceId !== null &&
              rule.providerInstances.has(subject.providerInstanceId))) &&
          (rule.branches.length === 0 || anyGlobMatches(rule.branches, branches)) &&
          (rule.workspacePaths.length === 0 || anyGlobMatches(rule.workspacePaths, workspaceRoots)),
      );
      if (matches) matched.push(group.id);
    }
    return matched.length === 0 ? NO_GROUPS : matched;
  };
}

export function sidebarFocusScopeIncludes(
  scope: SidebarFocusScope,
  matchedGroupIds: readonly string[],
): boolean {
  return scope.type === "ungrouped"
    ? matchedGroupIds.length === 0
    : matchedGroupIds.includes(scope.groupId);
}

/** Drops a scope whose group was deleted, so the sidebar falls back to everything. */
export function resolveSidebarFocusScope(
  scope: SidebarFocusScope | null,
  groups: readonly SidebarFocusGroup[],
): SidebarFocusScope | null {
  if (scope === null || groups.length === 0) return null;
  if (scope.type === "ungrouped") return scope;
  return groups.some((group) => group.id === scope.groupId) ? scope : null;
}

/** Cycles everything → each group in order → threads in no group → everything. */
export function stepSidebarFocusScope(input: {
  readonly scope: SidebarFocusScope | null;
  readonly groups: readonly SidebarFocusGroup[];
  readonly direction: 1 | -1;
}): SidebarFocusScope | null {
  const steps: Array<SidebarFocusScope | null> = [
    null,
    ...input.groups.map((group) => ({ type: "group" as const, groupId: group.id })),
  ];
  if (input.groups.length > 0) steps.push({ type: "ungrouped" });
  const scope = resolveSidebarFocusScope(input.scope, input.groups);
  const index = steps.findIndex((step) =>
    step === null || scope === null
      ? step === scope
      : step.type === "ungrouped"
        ? scope.type === "ungrouped"
        : scope.type === "group" && scope.groupId === step.groupId,
  );
  return steps[(index + input.direction + steps.length) % steps.length] ?? null;
}
