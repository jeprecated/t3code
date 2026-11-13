import type { AnyRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import {
  dispatchCommandPalette,
  isCommandPaletteMounted,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { overlayModeForCommand } from "../components/CommandPalette.logic";
import { APPEARANCE_OPTIONS, notifyThemeSaveFailure } from "../components/CommandPaletteThemeItems";
import { toggleThemeEditorForTheme } from "../components/settings/themeEditorStore";
import { toastManager } from "../components/ui/toast";
import { getThemeSnapshot, setAppearanceMode } from "../hooks/useTheme";
import { m } from "../i18n/messages";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { type CommandHandler, type CommandScopeOptions, registerCommands } from "./dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { stepSidebarCategory } from "../threadCategories";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { openNextYouQueueItem } from "../youQueue";

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

const toggleOverlay =
  (command: Parameters<typeof overlayModeForCommand>[0]): CommandHandler =>
  (event) => {
    const mode = overlayModeForCommand(command);
    if (mode === null) return false;
    consume(event);
    dispatchCommandPalette({ _tag: "ToggleMode", mode });
  };

/**
 * Palette, theme and usage shortcuts. They read the route, panels and theme
 * when the key is pressed, and are live only while the palette is mounted.
 */
export function installCommandPaletteCommands(
  router: AnyRouter,
  options: Pick<CommandScopeOptions, "keybindings"> = {},
): () => void {
  const readRouteThreadRef = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    return target?.kind === "server" ? target.threadRef : null;
  };

  const routeContext = () => {
    const threadRef = readRouteThreadRef();
    return {
      terminalOpen: threadRef
        ? selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            threadRef,
          ).terminalOpen
        : false,
      previewOpen: threadRef
        ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
        : false,
      usagePageOpen: router.state.location.pathname === "/usage",
    };
  };

  // A child search (files, contents) goes back to the palette on Escape before
  // its own widgets or the dialog can treat the key as a close. The thread
  // switcher is a quick jump, so Escape closes it outright.
  const disposeEscape = registerCommands(
    {},
    {
      capture: true,
      when: isCommandPaletteMounted,
      onKeyDown: (event) => {
        if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") return false;
        const { open, mode } = useCommandPaletteStore.getState();
        if (!open || mode === "command" || mode === "threads") return false;
        consume(event);
        if (event.repeat) return;
        dispatchCommandPalette({ _tag: "BackToCommand" });
      },
    },
  );

  // Capture phase, like `sidebar.toggle`: the terminal consumes keys it
  // receives, and the thread switcher should open from anywhere.
  const disposeThreadSwitcher = registerCommands(
    { "threadSwitcher.toggle": toggleOverlay("threadSwitcher.toggle") },
    {
      ...options,
      capture: true,
      when: (event) =>
        isCommandPaletteMounted() &&
        !(event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")),
      context: routeContext,
    },
  );

  // Capture phase, like `sidebar.toggle`: the terminal consumes keys it
  // receives, and a sidebar filter shortcut should work from anywhere.
  const stepCategory =
    (direction: 1 | -1): CommandHandler =>
    (event) => {
      consume(event);
      if (event.repeat) return;
      stepSidebarCategory(direction);
    };
  const disposeCategorySteps = registerCommands(
    {
      "sidebar.nextCategory": stepCategory(1),
      "sidebar.previousCategory": stepCategory(-1),
      "sidebar.toggleYouQueue": (event) => {
        consume(event);
        if (event.repeat) return;
        useUiStateStore.getState().toggleSidebarMode();
      },
      "youQueue.next": (event) => {
        consume(event);
        if (event.repeat) return;
        openNextYouQueueItem(router);
      },
    },
    {
      ...options,
      capture: true,
      when: (event) =>
        isCommandPaletteMounted() &&
        !(event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")),
      context: routeContext,
    },
  );

  const disposeCommands = registerCommands(
    {
      "appearance.cycle": (event) => {
        consume(event);
        if (event.repeat) return;
        const { appearanceMode } = getThemeSnapshot();
        const index = APPEARANCE_OPTIONS.findIndex((option) => option.mode === appearanceMode);
        const nextMode = APPEARANCE_OPTIONS[(index + 1) % APPEARANCE_OPTIONS.length]!.mode;
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
          return;
        }
        toastManager.add({
          id: "appearance-cycle",
          title: m(
            msg(
              "{mode, select, system {Appearance: System} light {Appearance: Light} other {Appearance: Dark}}",
            ),
            { mode: nextMode },
          ),
          timeout: 1500,
        });
      },
      "theme.select": (event) => {
        consume(event);
        if (event.repeat) return;
        dispatchCommandPalette({ _tag: "OpenChangeTheme" });
      },
      "themeEditor.toggle": (event) => {
        consume(event);
        const { theme, themeHalves, resolvedTheme } = getThemeSnapshot();
        toggleThemeEditorForTheme({ theme, themeHalves, initialAppearance: resolvedTheme });
      },
      "usage.open": (event) => {
        consume(event);
        dispatchCommandPalette({ _tag: "SetOpen", open: false });
        void router.navigate({ to: "/usage" });
      },
      "commandPalette.toggle": toggleOverlay("commandPalette.toggle"),
      "filePicker.toggle": toggleOverlay("filePicker.toggle"),
      "projectSearch.toggle": toggleOverlay("projectSearch.toggle"),
    },
    {
      ...options,
      when: isCommandPaletteMounted,
      context: routeContext,
    },
  );

  return () => {
    disposeEscape();
    disposeThreadSwitcher();
    disposeCategorySteps();
    disposeCommands();
  };
}
