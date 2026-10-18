import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, NewThreadPreset, ScopedProjectRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

type NewThreadContext = Pick<
  ReturnType<typeof useHandleNewThread>,
  "activeDraftThread" | "defaultProjectRef" | "handleNewThread"
> & { readonly activeThread: ReturnType<typeof useHandleNewThread>["activeThread"] | undefined };

/**
 * Starts a draft from a preset. The context is read when a preset starts, so
 * keyboard commands outside React (shortcuts/chatRouteCommands) can use it too.
 */
export function createStartNewThreadPreset(input: {
  readonly context: () => NewThreadContext;
  readonly scratch: Pick<
    ReturnType<typeof useScratchProject>,
    "scratchEnvironmentId" | "scratchWorkspaceRootFor" | "openScratchProject"
  >;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
}) {
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = input.scratch;

  const warn = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "warning", title, description }));

  const resolveProjectRef = async (
    preset: NewThreadPreset,
    { activeDraftThread, activeThread, defaultProjectRef, handleNewThread }: NewThreadContext,
  ): Promise<ScopedProjectRef | null> => {
    if (preset.project === "pinned") {
      const projectRef = scopeProjectRef(preset.environmentId, preset.projectId);
      if (readProject(projectRef)) return projectRef;
      warn(
        `${preset.name}: project unavailable`,
        "Its project was removed. Save the preset again from a draft in the project you want.",
      );
      return null;
    }
    if (preset.project === "none") {
      const environmentId = scratchEnvironmentId(
        preset.environmentId ??
          activeThread?.environmentId ??
          activeDraftThread?.environmentId ??
          input.primaryEnvironmentId(),
      );
      if (environmentId === null) {
        warn(
          `${preset.name}: machine unavailable`,
          "Its machine is not connected or cannot start threads without a project.",
        );
        return null;
      }
      const project = await openScratchProject(environmentId);
      return project ? scopeProjectRef(project.environmentId, project.id) : null;
    }
    const current = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    const currentProject = current ? readProject(current) : null;
    // From a thread without a project, a project preset falls back to the
    // first sidebar project instead of starting another scratch draft.
    return currentProject &&
      isScratchProject(currentProject, scratchWorkspaceRootFor(currentProject.environmentId))
      ? defaultProjectRef
      : current;
  };

  return async (preset: NewThreadPreset): Promise<void> => {
    const context = input.context();
    const projectRef = await resolveProjectRef(preset, context);
    if (!projectRef) return;
    const opened = await context.handleNewThread(
      projectRef,
      preset.project === "none"
        ? {}
        : {
            ...(preset.envMode !== undefined ? { envMode: preset.envMode } : {}),
            ...(preset.startFromOrigin !== undefined
              ? { startFromOrigin: preset.startFromOrigin }
              : {}),
          },
    );
    if (!opened) return;

    const provider = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(projectRef.environmentId)
      ?.providers.find((entry) => entry.instanceId === preset.modelSelection.instanceId);
    if (!provider?.enabled) {
      warn(
        `${preset.name}: model unavailable`,
        `This machine has no enabled provider "${preset.modelSelection.instanceId}", so the draft keeps its usual model.`,
      );
      return;
    }
    useComposerDraftStore.getState().setModelSelection(opened.draftId, preset.modelSelection, {
      explicit: true,
      replaceOptions: true,
    });
  };
}

export function useStartNewThreadPreset() {
  const newThread = useHandleNewThread();
  const scratch = useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return createStartNewThreadPreset({
    context: () => newThread,
    scratch,
    primaryEnvironmentId: () => primaryEnvironmentId,
  });
}
