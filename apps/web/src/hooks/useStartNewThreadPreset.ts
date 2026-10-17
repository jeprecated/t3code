import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { NewThreadPreset, ScopedProjectRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

export function useStartNewThreadPreset() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const resolveProjectRef = async (preset: NewThreadPreset): Promise<ScopedProjectRef | null> => {
    if (preset.project === "none") {
      const environmentId = scratchEnvironmentId(
        activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
      );
      if (environmentId === null) return null;
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
    const projectRef = await resolveProjectRef(preset);
    if (!projectRef) return;
    const opened = await handleNewThread(projectRef, {
      ...(preset.project === "current" && preset.envMode !== undefined
        ? { envMode: preset.envMode }
        : {}),
      ...(preset.project === "current" && preset.startFromOrigin !== undefined
        ? { startFromOrigin: preset.startFromOrigin }
        : {}),
    });
    if (!opened) return;

    const provider = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(projectRef.environmentId)
      ?.providers.find((entry) => entry.instanceId === preset.modelSelection.instanceId);
    if (!provider?.enabled) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `${preset.name}: model unavailable`,
          description: `This machine has no enabled provider "${preset.modelSelection.instanceId}", so the draft keeps its usual model.`,
        }),
      );
      return;
    }
    useComposerDraftStore.getState().setModelSelection(opened.draftId, preset.modelSelection, {
      explicit: true,
      replaceOptions: true,
    });
  };
}
