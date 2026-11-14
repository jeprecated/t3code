# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start from a preset

A preset saves a new thread's model, effort, and workspace, plus where it starts:
a specific project on its machine, whichever project you are in, or no project.
Set up a new thread the way you want it, open the command palette, and choose
**Save draft as new-thread preset…**, then pick the project option. Saving under
an existing name replaces that preset.

A preset that follows your current project, or starts without one, can be tied to
one machine, for example when its model's provider only exists there. Started
from a project on another machine, it opens the same repository on the pinned
machine, or no project there when that machine lacks the repository. It never
starts elsewhere: while the pinned machine is disconnected, it shows a warning.
Choose the machine when saving, or change it later in Settings → Threads.

To pick a preset, bind **Chat: New From Preset** in Settings → Keybindings; it
opens a list of your presets. They also appear at the top of **New thread in…**
and under **New thread from preset…** in the command palette. To start one
directly, bind its `preset.{id}.new` command. Presets are saved on each machine,
and you can rename, re-pin, or delete them in Settings → Threads.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
the pinned section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Turn on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. Pinned projects come first. A project with no active
threads has no folder unless it is pinned or you pick it in the project filter. An archived
project's folder comes last and shows only while it has active threads. Click a folder to open or
close it. A closed folder shows how many threads it holds, and a dot when one of them
needs you. Use the pen button on a folder, or right-click it, to start a thread in that project.
Pinned threads stay above the folders, and Snoozed and Settled stay below them. In this mode you
cannot drag threads, and the Working section is off. Each device keeps its own choice.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise the thread itself, which pastes into a composer as
a thread chip. To copy the thread even when it has a PR, choose **Copy → Thread**
from its context menu, or **Copy thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

### Group threads into categories

On web and desktop, a category names a set of threads you want to see together,
such as one client's repositories or everything about your mobile apps. Create one
with **New category…** in the sidebar's filter menu or the command palette, or in
**Settings → General → Thread categories**, where you drag categories into the order
the sidebar shows and expand one to edit its rules. They are saved on every
connected environment, so agents there can see them too; an environment that was
offline picks up the list on your next edit.

A category's rules match on project, repository, environment, provider, branch, or
project path. Type in **Projects** to pick projects by name; a name matches that
project on every machine, wherever its folder is, and stops matching if you rename
the project. Repository, branch, and path fields take comma-separated patterns where
`*` matches anything, for example `github.com/acme/*`. A thread joins a category when
every field of any one rule matches. Repositories match by remote, so one rule
covers the same repository on every connected environment.

A thread can also join or leave a category on its own, whatever the rules say. Open
**Categories** from the thread's menu in the sidebar or chat header, or **Thread
categories…** in the command palette. Unchecking a category the rules give a thread
removes it for that thread only; checking it again restores the rule. Changing a
thread's categories never changes its project, checkout, or provider. Agents can
list categories and tag threads with the `t3_thread_categories` and
`t3_thread_categorize` tools.

After a thread's first substantive message, T3 Code asks the environment's text
generation model which categories fit and shows **Suggested categories** above the
composer. **Apply** adds them, **Edit** lets you pick, and dismissing hides them.
Suggestions only see category names and descriptions, so give a category whose name
says little a short description, such as "Skool, content creation". A dismissed or
removed category is not suggested for that thread again. As a thread grows, T3 Code
occasionally checks again in case it changed direction.

Pick a category from the sidebar's filter menu to show only its threads; search and
thread shortcuts then stay within it. **Uncategorized** shows threads in no category.
Each thread is marked on its left edge with the colors of its categories, except the
one you are filtering by. When the filter hides a thread that needs your input or
approval, the top of the list says so; click it to show all threads.

To show several categories at once, choose **New view…** in the filter menu, name the
view, and set each category to **Include** or **Exclude**. A view shows threads in any
included category and in no excluded one; with nothing included, it shows every thread
outside the excluded categories, uncategorized ones too. Views are shared by every device connected to your
machines. Edit or delete one with the pencil beside it, or with **Edit sidebar view…**
in the command palette while it is showing. The alarm clock beside the pencil snoozes
every thread the view lists until the time you pick, then moves to the next view.
Threads waiting on your reply or approval are left alone.

To step through filters from the keyboard, assign `sidebar.nextCategory` and
`sidebar.previousCategory` in **Settings → Keybindings**. Once you have views, the
shortcut steps through All and each view, passing over views whose threads are all
snoozed or settled; until then it steps through All, each category, and
Uncategorized. The command palette also lists **Filter sidebar by
category…**.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually. Do this when the provider reports no reset time, because nothing
continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3 Code running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details.

A side chat works in the same folder as the thread. Its first reply asks before it
edits files or runs commands. After that, it uses the permission mode you choose
in its composer.

To use what you learned, choose **Bring back**. The thread gets the side chat with
your next message there. Bring back is available while the thread is idle.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Cockpit

The cockpit collects everything agents wait on you for, on every connected machine:
approvals and questions, decisions, manual steps, blocked work and review requests that
agents filed, proposed plans, failed or rate-limited runs, and your own todos. Open it with
**Cockpit** at the top of the sidebar, `mod+alt+y` (`cockpit.toggle`), or **Open cockpit**
in the command palette. The count is what you can do now.

The list on the left reads like the thread sidebar: **Overview agent** first, then every
task waiting on you, then **Snoozed**. Select an entry to see it on the right. A task shows
the thread that asked, the agent's latest message, and any details it attached. Answer a
question or approve a request right there. For a decision, pick an option; for a manual step
or blocked work, choose **Done**, with an optional note; for a review, **Looks good**, or
write feedback first. The agent is woken five seconds later, so the toast's **Undo** can
take it back. Secret and link requests, plans and failures are handled in their thread:
**Open there** jumps to the message. When a task is done, the next one in the list takes
its place.

**Snooze** puts one task off without snoozing its thread: pick 10 min, 30 min, 1 hour,
18:00, tomorrow 9:00 or Monday 9:00, or type a time such as `30m`, `14:30` or
`tomorrow 9`. Snoozes sync to your other devices. Snoozed tasks wait under **Snoozed** at
the bottom of the list until their time, or until you choose **Unsnooze**. Tasks an agent
gave a start time wait there too. In a thread, **Waiting on you** above the composer has
the same **Snooze**, and hides snoozed tasks behind **n snoozed**.

Everything works from the keyboard. Tab moves between the list and the selected entry. In
the list, the arrow keys select and Enter goes in; in a task, they move between its
controls. Esc goes back to the list, then closes. Press `?` in the cockpit to see every key
as you have bound it.

| Key       | Action                                                |
| --------- | ----------------------------------------------------- |
| `e`       | Done: answer, approve, resolve or complete            |
| `1`–`9`   | Pick an option; Space toggles one that allows several |
| `s`       | Snooze, then `1`–`6` or Tab to type a time            |
| `o`       | Open there                                            |
| `j` / `k` | Next / previous entry in the list                     |
| `y` / `n` | Approve / deny                                        |
| `shift+y` | Approve for this thread                               |
| `r`       | Write a note, your own answer, or feedback            |
| `l`       | Open the first link in the details                    |
| `u`       | Undo the last outcome                                 |
| `/`       | Select the overview agent and write to it             |
| `?`       | Show every key                                        |

Change any of them in **Settings → Keybindings**.

Select **Overview agent** and choose **Start overview agent** to create an Overview thread.
Tell it what you did, such as "the Stripe key is in", and it resolves the matching waits and
wakes those threads. It can also add todos for you. Its row shows when it is working or has
replied. Every morning at 09:00 it sweeps your threads for asks nobody recorded; change or
pause that in **Settings → Scheduled tasks**.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.
To snooze from the keyboard, bind `thread.snooze`; see
[keybindings](./keybindings.md#commands-with-special-behavior).
