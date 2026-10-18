import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { NewThreadPreset, ScopedProjectRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveNewThreadPresetStart } from "../newThreadPresets";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

export function useStartNewThreadPreset() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();

  const warn = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "warning", title, description }));

  const resolveTarget = async (
    preset: NewThreadPreset,
  ): Promise<{ projectRef: ScopedProjectRef; scratch: boolean } | null> => {
    const currentProjectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    const currentProject = currentProjectRef ? readProject(currentProjectRef) : null;
    const start = resolveNewThreadPresetStart({
      preset,
      currentProjectRef,
      currentProject,
      currentProjectIsScratch:
        currentProject !== null &&
        isScratchProject(currentProject, scratchWorkspaceRootFor(currentProject.environmentId)),
      currentEnvironmentId:
        activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
      defaultProjectRef,
      projects: readProjects(),
      isConnected: (environmentId) =>
        environments.find((environment) => environment.environmentId === environmentId)?.connection
          .phase === "connected",
    });
    if (start === null) return null;
    switch (start.kind) {
      case "project":
        return { projectRef: start.projectRef, scratch: false };
      case "project-unavailable":
        warn(
          `${preset.name}: project unavailable`,
          "Its project was removed. Save the preset again from a draft in the project you want.",
        );
        return null;
      case "machine-unavailable": {
        const label = environments.find(
          (environment) => environment.environmentId === start.environmentId,
        )?.label;
        warn(
          `${preset.name}: machine unavailable`,
          `${label ?? "Its machine"} is not connected, so the preset did not start.`,
        );
        return null;
      }
      case "scratch": {
        const environmentId = scratchEnvironmentId(start.environmentId);
        if (environmentId === null) {
          warn(
            `${preset.name}: machine unavailable`,
            "Its machine is not connected or cannot start threads without a project.",
          );
          return null;
        }
        const project = await openScratchProject(environmentId);
        return project
          ? { projectRef: scopeProjectRef(project.environmentId, project.id), scratch: true }
          : null;
      }
    }
  };

  return async (preset: NewThreadPreset): Promise<void> => {
    const target = await resolveTarget(preset);
    if (!target) return;
    const { projectRef } = target;
    const opened = await handleNewThread(
      projectRef,
      // A thread without a project has no workspace to configure.
      preset.project === "none" || target.scratch
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
