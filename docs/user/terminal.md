# Terminal

T3 Code includes integrated terminals running on the environment's host machine, with persistent scrollback across reconnects.

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the T3 server's environment to an executable name or full path (no quotes or arguments) to override the platform default shell for new terminals. This does not affect agent commands or project setup/settle scripts.

Example for Git Bash on Windows (PowerShell, then fully quit and reopen T3 Code):

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

> Note: Use `bin\bash.exe`, not `git-bash.exe`. Remove with `$null` to restore the default.

## Floating terminal

The terminal normally docks below the chat and takes space from it. You can
instead pop it over the workspace when you need it and hide it again when you
are done. The same shells, scrollback, splits and tabs move with it.

| Action                                              | Default shortcut  | Command                        |
| --------------------------------------------------- | ----------------- | ------------------------------ |
| Show or hide the terminal where it last was         | `mod+j`           | `terminal.toggle`              |
| Show the terminal floating, or hide it if it is     | `mod+alt+j`       | `terminal.toggleFloating`      |
| Move to the next place                              | `mod+alt+k`       | `terminal.cycleFloatingLayout` |
| Switch between the dock and the last floating place | `mod+alt+shift+j` | `terminal.toggleDocked`        |

The places cycle through the dock, centered, enlarged, right half and bottom
right. The terminal button in the top bar always shows the terminal in the dock,
or hides it if it is already docked. The place you last used applies to every
thread on this device. When the workspace is narrow the floating terminal fills
it.

Set the width and color of the floating terminal's border under
**Settings → Appearance**. Change the shortcuts in **Settings → Keybindings**;
see [Keybindings](keybindings.md).

## Scrollback and navigation

Each terminal retains up to **5,000 lines** and **8 MiB** of scrollback on the server.

| Action                     | macOS                              | Windows / Linux                            |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| Scroll page up/down        | `Shift+PageUp` / `Shift+PageDown`  | `Shift+PageUp` / `Shift+PageDown`          |
| Jump to start / latest     | `Cmd+Shift+Home` / `Cmd+Shift+End` | `Ctrl+Shift+Home` / `Ctrl+Shift+End`       |
| Select all retained output | `Cmd+A`                            | `Ctrl+Shift+A` (`Ctrl+A` stays shell home) |
| Next / previous terminal   | `Cmd+Shift+]` / `Cmd+Shift+[`      | `Ctrl+Alt+]` / `Ctrl+Alt+[`                |

On iOS/iPadOS, long-press the terminal to paste or choose **Select Text**.

## fish shell

T3 Code launches `fish` with `no-query-term` to avoid startup delays, which overrides universal `fish_features`. To keep custom flags or re-enable `query-term`, export `fish_features` in the environment that launches T3 Code.
