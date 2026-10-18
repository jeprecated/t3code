import {
  countSubstantiveUserMessages,
  pendingThreadCategorySuggestion,
  threadCategoryChange,
  threadCategoryLabel,
  threadCategorySelectionChanges,
  threadCategorySuggestionDue,
  type ThreadCategorySubject,
} from "@t3tools/shared/threadCategories";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadCategories,
  type ScopedThreadRef,
  type ThreadCategory,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { TagIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { suggestThreadCategories } from "~/state/threadCategories";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  environmentSupportsThreadCategories,
  resolveThreadCategoryMembership,
  useThreadCategories,
  useUpdateThreadCategories,
} from "~/threadCategories";
import { CategorySwatch } from "../CategorySwatch";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { composerFloatingLayerProps } from "./composerEventScope";

// Reopening an old thread should not ask about it; continuing one may.
const SUGGESTION_RECENCY_MS = 15 * 60_000;

function ThreadCategoryEditor(props: {
  readonly categories: readonly ThreadCategory[];
  readonly initialSelectedIds: readonly string[];
  readonly onApply: (selectedIds: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSelected(new Set(props.initialSelectedIds));
        setOpen(next);
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>Edit</PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        padding="compact"
        width="sm"
      >
        <div className="flex flex-col gap-0.5">
          {props.categories.map((category) => (
            <label
              key={category.id}
              className="flex cursor-pointer items-center gap-2 rounded-md py-1 text-sm"
            >
              <Checkbox
                checked={selected.has(category.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(category.id);
                    else next.delete(category.id);
                    return next;
                  })
                }
              />
              <CategorySwatch color={category.color} className="size-3" />
              <span className="min-w-0 truncate">{threadCategoryLabel(category)}</span>
            </label>
          ))}
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={() => {
                props.onApply([...selected]);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Asks the thread's environment for category suggestions while the thread is
 * open and growing, and offers the stored answer above the composer. The
 * server re-checks that a suggestion is due, so another open client asking at
 * the same time costs nothing.
 */
export function useThreadCategorySuggestionBanner(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly subject: ThreadCategorySubject | null;
  readonly state: OrchestrationV2ThreadCategories | null | undefined;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage> | null;
}): ComposerBannerStackItem | null {
  const { threadRef, subject, messages } = input;
  const categories = useThreadCategories();
  const environmentId = threadRef?.environmentId ?? null;
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null && environmentSupportsThreadCategories(serverConfigs.get(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const suggest = useAtomCommand(suggestThreadCategories, {
    reportFailure: false,
    reportDefect: false,
  });
  const updateThreadCategories = useUpdateThreadCategories();

  const membership =
    supported && subject !== null && categories.length > 0
      ? resolveThreadCategoryMembership({ categories, subject, state: input.state })
      : null;
  const pending = membership
    ? pendingThreadCategorySuggestion(categories, membership.categoryIds, membership.state)
    : [];
  const settledMessages = messages?.filter((message) => !message.streaming) ?? [];
  const substantiveCount = countSubstantiveUserMessages(settledMessages);
  const due =
    canOperate &&
    membership !== null &&
    pending.length === 0 &&
    threadCategorySuggestionDue(membership.state, substantiveCount);
  const latestUserMessage = settledMessages.findLast((message) => message.role === "user");
  const latestUserMessageAt = latestUserMessage
    ? DateTime.toEpochMillis(latestUserMessage.createdAt)
    : null;

  const requestSuggestion = useEffectEvent(() => {
    if (threadRef === null) return;
    void suggest({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
  });
  useEffect(() => {
    if (
      due &&
      latestUserMessageAt !== null &&
      Date.now() - latestUserMessageAt <= SUGGESTION_RECENCY_MS
    ) {
      requestSuggestion();
    }
  }, [due, latestUserMessageAt]);

  if (membership === null || threadRef === null || pending.length === 0) return null;
  return {
    id: `category-suggestion:${threadRef.environmentId}:${threadRef.threadId}`,
    variant: "info",
    priority: "notice",
    icon: <TagIcon />,
    title: `Suggested categories: ${pending.map(threadCategoryLabel).join(" · ")}`,
    actions: (
      <>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canOperate}
          onClick={() =>
            void updateThreadCategories(threadRef, {
              changes: pending.map((category) =>
                threadCategoryChange({
                  ruleCategoryIds: membership.ruleCategoryIds,
                  categoryId: category.id,
                  member: true,
                }),
              ),
              resolveSuggestion: true,
            })
          }
        >
          Apply
        </Button>
        <ThreadCategoryEditor
          categories={categories}
          initialSelectedIds={[
            ...membership.categoryIds,
            ...pending.map((category) => category.id),
          ]}
          onApply={(selectedIds) =>
            void updateThreadCategories(threadRef, {
              changes: threadCategorySelectionChanges({
                categories,
                ruleCategoryIds: membership.ruleCategoryIds,
                state: membership.state,
                selectedIds,
              }),
              resolveSuggestion: true,
            })
          }
        />
      </>
    ),
    dismissLabel: "Dismiss suggested categories",
    onDismiss: () => void updateThreadCategories(threadRef, { resolveSuggestion: true }),
  };
}
