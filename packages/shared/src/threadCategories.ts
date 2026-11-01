import type {
  OrchestrationV2ThreadCategories,
  OrchestrationV2ThreadCategoryChange,
  RepositoryIdentity,
  ThreadCategory,
} from "@t3tools/contracts";

/** What a category's rules can see about a thread. Server and clients build the same subject. */
export interface ThreadCategorySubject {
  readonly environmentId: string;
  readonly providerInstanceId: string | null;
  readonly branch: string | null;
  readonly project: {
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  } | null;
}

export type ThreadCategoryMatcher = (subject: ThreadCategorySubject) => readonly string[];

const NO_CATEGORIES: readonly string[] = [];

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
 * A rule matches when every field it fills in matches; a category matches when
 * any of its rules does. A rule with no filled-in fields matches nothing, so a
 * freshly added rule never silently captures every thread.
 */
export function compileThreadCategoryRules(
  categories: readonly ThreadCategory[],
): ThreadCategoryMatcher {
  const compiled = categories.map((category) => ({
    id: category.id,
    rules: category.rules
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
  if (compiled.every((category) => category.rules.length === 0)) return () => NO_CATEGORIES;

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
    for (const category of compiled) {
      const matches = category.rules.some(
        (rule) =>
          (rule.repositories.length === 0 || anyGlobMatches(rule.repositories, repositoryKeys)) &&
          (rule.environments.size === 0 || rule.environments.has(subject.environmentId)) &&
          (rule.providerInstances.size === 0 ||
            (subject.providerInstanceId !== null &&
              rule.providerInstances.has(subject.providerInstanceId))) &&
          (rule.branches.length === 0 || anyGlobMatches(rule.branches, branches)) &&
          (rule.workspacePaths.length === 0 || anyGlobMatches(rule.workspacePaths, workspaceRoots)),
      );
      if (matches) matched.push(category.id);
    }
    return matched.length === 0 ? NO_CATEGORIES : matched;
  };
}

type ThreadCategoryState = OrchestrationV2ThreadCategories | null | undefined;

/** Rule matches plus the thread's own inclusions, minus its exclusions, in category order. */
export function resolveThreadCategoryIds(
  categories: readonly ThreadCategory[],
  ruleCategoryIds: readonly string[],
  state: ThreadCategoryState,
): readonly string[] {
  if (!state || (state.included.length === 0 && state.excluded.length === 0)) {
    return ruleCategoryIds;
  }
  const ruleIds = new Set(ruleCategoryIds);
  const included = new Set(state.included);
  const excluded = new Set(state.excluded);
  const ids = categories
    .filter(
      (category) =>
        (ruleIds.has(category.id) || included.has(category.id)) && !excluded.has(category.id),
    )
    .map((category) => category.id);
  return ids.length === 0 ? NO_CATEGORIES : ids;
}

/**
 * The change that makes a thread a member or not. Checking a category the
 * rules already give the thread only drops its exclusion, so a later rule edit
 * still applies; unchecking is always an explicit exclusion, which also keeps
 * it out of future suggestions.
 */
export function threadCategoryChange(input: {
  readonly ruleCategoryIds: readonly string[];
  readonly categoryId: string;
  readonly member: boolean;
}): OrchestrationV2ThreadCategoryChange {
  const { categoryId } = input;
  if (!input.member) return { categoryId, state: "exclude" };
  return { categoryId, state: input.ruleCategoryIds.includes(categoryId) ? "inherit" : "include" };
}

/** Changes that make `selectedIds` exactly the thread's categories. */
export function threadCategorySelectionChanges(input: {
  readonly categories: readonly ThreadCategory[];
  readonly ruleCategoryIds: readonly string[];
  readonly state: ThreadCategoryState;
  readonly selectedIds: readonly string[];
}): readonly OrchestrationV2ThreadCategoryChange[] {
  const effective = new Set(
    resolveThreadCategoryIds(input.categories, input.ruleCategoryIds, input.state),
  );
  const selected = new Set(input.selectedIds);
  return input.categories
    .filter((category) => selected.has(category.id) !== effective.has(category.id))
    .map((category) =>
      threadCategoryChange({
        ruleCategoryIds: input.ruleCategoryIds,
        categoryId: category.id,
        member: selected.has(category.id),
      }),
    );
}

/** Applies a `thread.categories.update` to the stored state. */
export function applyThreadCategoryChanges(
  state: ThreadCategoryState,
  changes: readonly OrchestrationV2ThreadCategoryChange[],
  resolveSuggestion: boolean,
): OrchestrationV2ThreadCategories {
  let included = new Set(state?.included ?? []);
  let excluded = new Set(state?.excluded ?? []);
  let dismissed = new Set(state?.dismissed ?? []);
  let suggested = new Set(state?.suggested ?? []);
  for (const change of changes) {
    included.delete(change.categoryId);
    excluded.delete(change.categoryId);
    suggested.delete(change.categoryId);
    if (change.state === "include") {
      included.add(change.categoryId);
      dismissed.delete(change.categoryId);
    } else if (change.state === "exclude") {
      excluded.add(change.categoryId);
    }
  }
  if (resolveSuggestion) {
    dismissed = new Set([...dismissed, ...suggested]);
    suggested = new Set();
  }
  return {
    included: [...included],
    excluded: [...excluded],
    suggested: [...suggested],
    dismissed: [...dismissed],
    reviewedMessageCount: state?.reviewedMessageCount ?? 0,
  };
}

/** Categories a suggestion may still offer: not already the thread's, excluded, or dismissed. */
export function threadCategorySuggestionCandidates(
  categories: readonly ThreadCategory[],
  effectiveCategoryIds: readonly string[],
  state: ThreadCategoryState,
): readonly ThreadCategory[] {
  const ruledOut = new Set([
    ...effectiveCategoryIds,
    ...(state?.excluded ?? []),
    ...(state?.dismissed ?? []),
  ]);
  return categories.filter((category) => !ruledOut.has(category.id));
}

/** The stored suggestion, without categories since deleted, applied, or ruled out. */
export function pendingThreadCategorySuggestion(
  categories: readonly ThreadCategory[],
  effectiveCategoryIds: readonly string[],
  state: ThreadCategoryState,
): readonly ThreadCategory[] {
  if (!state || state.suggested.length === 0) return [];
  const suggested = new Set(state.suggested);
  return threadCategorySuggestionCandidates(categories, effectiveCategoryIds, state).filter(
    (category) => suggested.has(category.id),
  );
}

const MIN_SUBSTANTIVE_MESSAGE_LENGTH = 12;

export function countSubstantiveUserMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user" && message.text.trim().length >= MIN_SUBSTANTIVE_MESSAGE_LENGTH) {
      count += 1;
    }
  }
  return count;
}

/**
 * Suggests after the first substantive message, then each time the thread has
 * roughly doubled, so a thread that changes direction is reconsidered without
 * a model call on every message.
 */
export function threadCategorySuggestionDue(
  state: ThreadCategoryState,
  substantiveMessageCount: number,
): boolean {
  const reviewed = state?.reviewedMessageCount ?? 0;
  return substantiveMessageCount >= (reviewed === 0 ? 1 : reviewed * 2 + 1);
}

export function threadCategoryLabel(category: Pick<ThreadCategory, "name">): string {
  return category.name.trim() || "Untitled category";
}
