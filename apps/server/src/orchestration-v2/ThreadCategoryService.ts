import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  applyThreadCategoryChanges,
  compileThreadCategoryRules,
  countSubstantiveUserMessages,
  resolveThreadCategoryIds,
  threadCategoryChange,
  threadCategoryLabel,
  threadCategorySuggestionCandidates,
  threadCategorySuggestionDue,
} from "@t3tools/shared/threadCategories";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadCategories,
  type ServerSettingsError,
  type ThreadCategory,
  type ThreadId,
} from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadCategoryNotFoundError extends Schema.TaggedError<ThreadCategoryNotFoundError>()(
  "ThreadCategoryNotFoundError",
  {
    threadId: Schema.String,
    unknownCount: Schema.Number,
  },
) {
  override get message(): string {
    return "No category in this environment matches that name or id.";
  }
}

export interface ThreadCategoryMembership {
  readonly threadId: ThreadId;
  /** The thread's categories: rule matches plus its own changes, in category order. */
  readonly categoryIds: readonly string[];
  readonly ruleCategoryIds: readonly string[];
  readonly state: OrchestrationV2ThreadCategories | null;
}

type ThreadCategoryReadError =
  | OrchestratorV2Error
  | ProjectStore.ProjectStoreV2Error
  | ServerSettingsError;

type ThreadCategoryWriteError =
  | ThreadCategoryReadError
  | ThreadManagementService.ThreadManagementProviderInstanceDisabledError;

/**
 * Categories are `threadCategories` in server settings; a thread's own changes
 * live on the thread. Clients, agents (MCP), and suggestions all resolve a
 * thread's categories here, with the same rules the clients apply.
 */
export class ThreadCategoryService extends Context.Service<
  ThreadCategoryService,
  {
    readonly list: Effect.Effect<readonly ThreadCategory[], ServerSettingsError>;
    readonly membership: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadCategoryMembership, ThreadCategoryReadError>;
    /** Adds and removes categories, each named by id or (case-insensitively) by name. */
    readonly update: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly add: readonly string[];
      readonly remove: readonly string[];
    }) => Effect.Effect<
      ThreadCategoryMembership,
      ThreadCategoryWriteError | ThreadCategoryNotFoundError
    >;
    /**
     * Suggests categories with the thread title model when the thread is due
     * (its first substantive message, then each time it roughly doubles) and
     * stores the answer on the thread. Returns the pending suggestion.
     */
    readonly suggest: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly suggested: readonly string[] }, ThreadCategoryWriteError>;
  }
>()("t3/orchestration-v2/ThreadCategoryService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const suggesting = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());

  const list = serverSettings.getSettings.pipe(Effect.map((settings) => settings.threadCategories));

  const ruleCategoryIdsOf = Effect.fn("ThreadCategoryService.ruleCategoryIds")(function* (
    categories: readonly ThreadCategory[],
    thread: OrchestrationV2AppThread,
  ) {
    if (categories.length === 0) return [];
    const project = yield* projects.get(thread.projectId);
    const workspaceRoot = Option.isSome(project) ? project.value.workspaceRoot : null;
    return compileThreadCategoryRules(categories)({
      environmentId: yield* environment.getEnvironmentId,
      providerInstanceId: thread.providerInstanceId,
      branch: thread.branch,
      project:
        workspaceRoot === null
          ? null
          : {
              workspaceRoot,
              repositoryIdentity: yield* repositoryIdentities.resolve(workspaceRoot),
            },
    });
  });

  const membershipOf = Effect.fn("ThreadCategoryService.membershipOf")(function* (
    categories: readonly ThreadCategory[],
    thread: OrchestrationV2AppThread,
  ) {
    const ruleCategoryIds = yield* ruleCategoryIdsOf(categories, thread);
    const state = thread.categories ?? null;
    return {
      threadId: thread.id,
      categoryIds: resolveThreadCategoryIds(categories, ruleCategoryIds, state),
      ruleCategoryIds,
      state,
    } satisfies ThreadCategoryMembership;
  });

  const membership: ThreadCategoryService["Service"]["membership"] = Effect.fn(
    "ThreadCategoryService.membership",
  )(function* (threadId) {
    const { thread } = yield* threads.getThreadRecords(threadId, []);
    return yield* membershipOf(yield* list, thread);
  });

  const update: ThreadCategoryService["Service"]["update"] = Effect.fn(
    "ThreadCategoryService.update",
  )(function* (input) {
    const categories = yield* list;
    const resolve = (reference: string) => {
      const key = reference.trim().toLowerCase();
      return (
        categories.find((category) => category.id === reference.trim()) ??
        categories.find((category) => threadCategoryLabel(category).toLowerCase() === key)
      );
    };
    const added = input.add.map(resolve);
    const removed = input.remove.map(resolve);
    const unknownCount = [...added, ...removed].filter((category) => !category).length;
    if (unknownCount > 0) {
      return yield* new ThreadCategoryNotFoundError({ threadId: input.threadId, unknownCount });
    }
    const { thread } = yield* threads.getThreadRecords(input.threadId, []);
    const ruleCategoryIds = yield* ruleCategoryIdsOf(categories, thread);
    const changes = [
      ...added.flatMap((category) =>
        category
          ? [threadCategoryChange({ ruleCategoryIds, categoryId: category.id, member: true })]
          : [],
      ),
      ...removed.flatMap((category) =>
        category
          ? [threadCategoryChange({ ruleCategoryIds, categoryId: category.id, member: false })]
          : [],
      ),
    ];
    yield* threads.dispatch({
      type: "thread.categories.update",
      commandId: input.commandId,
      threadId: input.threadId,
      changes,
    });
    const state = applyThreadCategoryChanges(thread.categories, changes, false);
    return {
      threadId: input.threadId,
      categoryIds: resolveThreadCategoryIds(categories, ruleCategoryIds, state),
      ruleCategoryIds,
      state,
    };
  });

  const suggestFrom = Effect.fn("ThreadCategoryService.suggestFrom")(function* (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly messages: Parameters<typeof formatThreadTitleContext>[0];
    readonly candidates: readonly ThreadCategory[];
    readonly currentNames: readonly string[];
  }) {
    const { message: conversation } = formatThreadTitleContext(input.messages);
    if (conversation.trim().length === 0) return [];
    const project = yield* projects.get(input.thread.projectId);
    if (Option.isNone(project)) return [];
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      input.thread.projectId,
    ).settings;
    return yield* textGeneration
      .generateThreadCategories({
        cwd: input.thread.worktreePath ?? project.value.workspaceRoot,
        conversation,
        categories: input.candidates.map((category) => ({
          id: category.id,
          name: threadCategoryLabel(category),
          description: category.description,
        })),
        currentCategoryNames: input.currentNames,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.map((result) => result.categoryIds),
        Effect.catchTags({
          TextGenerationError: (error) =>
            Effect.logWarning("Thread category suggestion failed", {
              threadId: input.thread.id,
              operation: error.operation,
            }).pipe(Effect.as<readonly string[]>([])),
        }),
      );
  });

  const suggest: ThreadCategoryService["Service"]["suggest"] = Effect.fn(
    "ThreadCategoryService.suggest",
  )(function* (threadId) {
    const categories = yield* list;
    const projection = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const state = projection.thread.categories ?? null;
    const pending = state?.suggested ?? [];
    const messages = projection.messages.filter((message) => !message.streaming);
    const reviewedMessageCount = countSubstantiveUserMessages(messages);
    if (
      categories.length === 0 ||
      pending.length > 0 ||
      !threadCategorySuggestionDue(state, reviewedMessageCount)
    ) {
      return { suggested: pending };
    }
    const claimed = yield* Ref.modify(suggesting, (current) =>
      current.has(threadId) ? [false, current] : [true, new Set([...current, threadId])],
    );
    if (!claimed) return { suggested: pending };

    return yield* Effect.gen(function* () {
      const current = yield* membershipOf(categories, projection.thread);
      const candidates = threadCategorySuggestionCandidates(categories, current.categoryIds, state);
      const offered = new Set(candidates.map((category) => category.id));
      const answer =
        candidates.length === 0
          ? []
          : yield* suggestFrom({
              thread: projection.thread,
              messages,
              candidates,
              currentNames: categories
                .filter((category) => current.categoryIds.includes(category.id))
                .map(threadCategoryLabel),
            });
      const suggested = answer.filter((id) => offered.has(id));
      // A failed or empty answer still counts as reviewed, so it is not retried
      // until the thread has grown again.
      yield* threads.dispatch({
        type: "thread.categories.suggestion.record",
        commandId: CommandId.make(`thread-categories:${threadId}:${reviewedMessageCount}`),
        threadId,
        suggested,
        reviewedMessageCount,
      });
      return { suggested };
    }).pipe(
      Effect.ensuring(
        Ref.update(suggesting, (current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        }),
      ),
    );
  });

  return ThreadCategoryService.of({ list, membership, update, suggest });
});

export const layer = Layer.effect(ThreadCategoryService, make);
