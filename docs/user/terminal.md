# Terminal

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

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
