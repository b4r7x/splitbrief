# Slash Commands Reference

The complete reference for every slash command available in the SPLITBRIEF TUI. This document is the exhaustive lookup — every entry in [`src/core/runtime/commands/defs/`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/defs) — one module per category, concatenated by `createRuntimeCommands` in `registry.ts` — is documented here, grouped by purpose, with usage, screen availability, behaviour, and cross-references.

If you only want a short overview, see [`FEATURES.md`](./FEATURES.md#slash-commands-palette). If you are adding a new command, follow the contract in [`src/core/runtime/commands/types.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/types.ts) and the dispatch rules in [`src/core/runtime/commands/dispatch.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/dispatch.ts).

## How dispatch works

Type `/` in the TUI to open the command picker. The picker lists the commands whose names start with the typed word, and `Enter` runs the highlighted row. When no name starts with the typed word, the picker shows one close command as a suggestion. The command palette (`Ctrl+K`) ranks commands by fuzzy match instead.

Dispatch inside `src/core/runtime/commands/dispatch.ts` resolves a typed line in three steps:

1. Exact match on `name`, ignoring case (`findRuntimeCommand`, `src/core/runtime/commands/lookup.ts`). There are no aliases and no prefix match.
2. If no exact match, a removed name gets a pointer to its replacement (`removedCommandPointer`, same module) instead of `Unknown command`.
3. Otherwise `suggestRuntimeCommand` in the same module may suggest a close command in the error message — it does not auto-execute. Example: `/usge` returns `Unknown command: /usge. Did you mean /usage?` without running `/usage`.

Each command declares `validScreens`. The screens are `home`, `workflow`, and `setup` (`src/core/navigation/types.ts`). Invoking a command on the wrong screen surfaces an error through the `feedbackStore`. The constant `ALL_SCREENS` (`src/core/navigation/types.ts`) is shorthand for "available everywhere".

Each command may also declare a `guard`, which returns one true sentence when the command cannot run right now (wrong phase, no vision on the PLAN seat) and `undefined` otherwise. The command palette, the composer `/` picker and the help overlay hide guarded-out rows. A change to the plan is requested on the plan card, not with a command.

Handlers reach the engine and stores through the `RuntimeCommandContext` interface in `src/core/runtime/commands/types.ts`, assembled by `createCommandContext` in `src/core/runtime/commands/context-factory.ts`; the TUI (`src/app/command-context.ts`) only supplies the callbacks. The registry itself never imports stores directly; this keeps the command list testable in isolation (see `src/core/runtime/commands/dispatch.test.ts`).

The slash commands — enumerated by [`src/core/runtime/commands/defs/`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/defs), the single source of truth — are 23 commands. Every one declares a `category` from the closed set in `src/core/runtime/commands/types.ts` — `navigate`, `crew`, `workflow`, `view`, `io` — and is in exactly one; the command palette and the sections below group by it.

A composer line is a slash command only when its first word is `/name` without another `/`; `/Users/me/notes.md` goes to the planner as text. A slash command runs in every composer mode, also while a question or a recovery menu waits for an answer; no seat ever reads it as a message. The command list opens there too; only a comment on an approval card gets no list. While the list is open, Tab fills in the highlighted row.

---

## Navigate

Commands that open an overlay or change which screen is active. `category: 'navigate'` in the registry; the command palette renders them under **Navigate**.

### `/help`

- **Purpose**: Open the help overlay — the slash commands you can run now, grouped by category, then the key bindings for the current screen.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+/` (`src/core/keybindings/registry.ts`).
- **Example**: `/help`
- **Behavior**: Opens the `help` overlay. Help uses the same filter as the command palette (`buildCommandItems`, `src/features/palette/sources.ts`). It leaves out `hidden` commands, commands for another screen and commands that a `guard` blocks now. Command rows follow the five categories, and a **Keyboard shortcuts** section follows them. Category headers appear when the panel has room for at least 12 rows (`SECTION_HEADER_MIN_ROWS`, `src/app/overlays/help.tsx`); a smaller panel keeps the order without headers. Press `Esc` to close.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/palette`.

### `/palette`

- **Purpose**: Open the command palette — a searchable, keyboard-driven list of every palette-eligible slash command. Useful when you don't remember the exact command name.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+K` (`src/core/keybindings/registry.ts`).
- **Example**: `/palette`
- **Behavior**: Opens the `command-palette` overlay. `/palette` itself is `hidden`, so it is typeable but never listed inside the palette. Palette sources are assembled in `src/features/palette/sources.ts` from labeled runtime commands, live tasks, recent sessions, and `palette.customActions` from config. With an empty query the rows are grouped by `category`. `Enter` on a command that takes an argument prefills `/name ` in the composer instead of running it bare. A typed draft is kept and comes back once that command is sent or cleared.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/help`.

### `/skills`

- **Purpose**: Pick the skills every seat carries for the session. Skills are instruction bundles that bias the planner, the implementer and the reviewer toward specific kinds of work (testing, refactoring, security review, etc.).
- **Screens**: all. A run builds its skills block once, when it starts or continues. A selection changed for an existing run applies to that continue only: it is not saved, and opening the run again from `/sessions`, home or the palette selects the skills it saved when it started. A new run saves the selection it starts with.
- **Args**: optional, and repeatable on one line — one or more whitespace-separated skill ids, from the ids `ctx.listSkills()` reports. Matching is fuzzy (`match: 'fuzzy'`), so a partial id resolves as long as it is unambiguous. The `/` menu completes them project-first, then already-selected global skills, then the rest, each row showing the skill's name and description, so a skill can be found by what it is for rather than by its id. Unknown ids print `"Unknown skill: <x>"` (`"Unknown skills: …"` for several).
- **Shortcut**: `Ctrl+S` (home screen only — see `src/core/keybindings/registry.ts`).
- **Example**: `/skills`, `/skills testing-standards`, `/skills testing-standards security-review`
- **Behavior**: Every invocation re-runs discovery first (`refreshSkills` in `src/app/refresh-skills.ts`), so a skill directory added since startup is present whether you open the picker or toggle by id. Bare `/skills` then opens the `skills` overlay; with arguments it toggles each named skill instead and reports through feedback (`Attached: …`, `Detached: …`). Toggling accumulates: `/skills alpha` then `/skills bravo` leaves both attached. The command palette additionally lists one `Skill · <name>` row per discovered skill, hinted `attached` when it is selected, which toggles it directly. Selection lives in `skillsStore` for the session only and is not written to `config.yaml`; headless and resumed runs select the same skills with `--skills <id,…>`. Picking `/skills` in the command palette prefills `/skills ` in the composer, the same as every other argument-taking command.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/settings`, `/crew`.

### `/sessions`

- **Purpose**: Browse past runs. Opens the sessions overlay backed by `.splitbrief/sessions/`; `⏎` opens the run on the workflow screen at rest, with its history replayed, whatever the run did — an open run is continued from there, a closed one is read.
- **Screens**: all.
- **Row time**: Each row shows the latest stop or end time, else the start time.
- **Args**: none.
- **Example**: `/sessions`
- **Behavior**: Opens the `sessions` overlay. Selecting a run reads its record, replays its `session.jsonl` into the workflow stores and opens the workflow screen at rest; the only refusal is a local run this process is already driving.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/home`, `/settings`.

### `/settings`

- **Purpose**: Open the settings overlay: Crew, Fallback, validation, workflow defaults, hooks.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+,` (`src/core/keybindings/registry.ts`).
- **Example**: `/settings`
- **Behavior**: Opens the `settings` overlay. Crew is first, with one read-only row per seat: PLAN, BUILD, REVIEW. Enter opens the seat's tool/model picker. Fallback is directly below Crew, with one fallback row per seat. Enter opens the same picker in its fallback slot; None clears the fallback. See [Configuration §fallback](./CONFIGURATION.md#fallback) for REVIEW inheritance and picker rules. The section order is Crew → Fallback → Tuning → Workflow → Validation. The Workflow group carries Plan approval (`plan` or `none`), Compaction format, Create branch and Isolation. Space cycles Isolation through `worktree`, `staged copy` and `your checkout`, saving `workflow.isolation` as `worktree`, `staged-copy` or `none`. Show spend and Commit strategy controls have been removed. Mutations are persisted to project config on save.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; opens the overlay via `overlayStore.open`; a focus of `seat:<id>`, `fallback:<seat>` or `filter:<text>` is parsed by `parseSettingsFocus` (`src/features/settings/focus.ts`).
- **See also**: `/crew`, `/skills`.

### `/home`

- **Purpose**: Navigate back to the home screen from the workflow screen. Leaving an active workflow unmounts the workflow UI and aborts the active run.
- **Screens**: `workflow`.
- **Args**: none.
- **Example**: `/home`
- **Behavior**: Calls `routerStore.navigate({ to: 'home' })`. The home screen shows the prompt input and recent sessions. While Apply writes to your checkout from this window, `/home` waits: the byline reads `Returns home when Apply finishes`, and a halted Apply keeps you on the run. In another window that has the run open, `/home` goes home at once.
- **Implementation**: catalog at `src/core/runtime/commands/defs/navigate.ts`; navigation wiring at `src/app/command-context.ts`.
- **See also**: `/sessions`, `/quit`.

### `/quit`

- **Purpose**: Stop the run safely, save the session, then exit. The TUI tears down and any in-flight subprocesses are killed via the process registry.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+Q` (`src/core/keybindings/registry.ts`). `Ctrl+C` quits only on a second press: on a live run the first press is Stop now and arms a two-second quit confirmation, and on other screens the first press only arms it. See [Global keys](#global-any-screen).
- **Example**: `/quit`
- **Behavior**: Routes through `requestQuit` (`src/features/workflow/handlers.ts`), which waits for the run to park or end before calling the `exit` callback wired in `src/app/command-context.ts`, so the session is saved rather than truncated; the byline reads `Quitting · Stopping processes and saving session` while it waits. No confirmation prompt — use `/home` if you only want to leave the workflow screen, or `esc` for the stop sheet if you want to stop the run without exiting.
- **Implementation**: catalog in `src/core/runtime/commands/defs/navigate.ts`.
- **See also**: `/home`, `/end`.

---

## Crew

Commands that decide who does the work and how: the three seats and tool detection. `category: 'crew'` in the registry.

### `/crew [plan|build|review]`

- **Purpose**: Change who fills a seat. One command for all three seats — `PLAN`, `BUILD`, `REVIEW`.
- **Screens**: all.
- **Args**: optional. One of `plan`, `build`, `review` (the `CREW_SEAT_IDS` tuple in `src/core/crew/identity.ts`, re-exported for commands as `CREW_COMMAND_SEATS`). Any other value prints `"Unknown seat: <x>. Valid: plan, build, review"`.
- **Example**: `/crew`, `/crew plan`, `/crew build`, `/crew review`
- **Behavior**: Bare `/crew` opens the `settings` overlay focused on the Crew section with the cursor on `plan` (`seat:plan`). `/crew <seat>` opens that seat's picker in the `seat` slot directly (`planner-picker`, `implementer-picker`, `reviewer-picker`, via `seatPickerOverlayFor` in `src/core/navigation/types.ts`). Esc from a directly opened picker returns to the screen it came from. Each Crew row shows one identity, with tool and model separated by ` · ` and billing posture beside it. The row mirrors effort and shows no fallback line. Enter opens the same picker and returns to Crew with the seat updated. The sub-screen titles name the seat, for example `Custom model · PLAN`. Saving writes the seat's tool, model and effort to `.splitbrief/config.yaml`. During a live run the panel says where the seat changes: `<SEAT> seat changes after T001` under a running brief, `after the next brief` while the plan is made, and `after a fix brief or at the next run` in the final review; the composer key legend says the same while the change waits. The running brief finishes on its original seat, then the run prepares the next brief on the saved config. A seat saved while a halt waits is taken when the run goes on: Try again or a correction runs on it. Change <SEAT> tool on the halt switches to the row you take in its picker; Esc keeps the halt and the saved seat. With no `reviewer` block, the REVIEW Crew row shows `= PLAN · <identity>`. Set a fallback separately in Settings › Fallback; a saved fallback applies at the next halt in any phase.
- **Implementation**: catalog at `src/core/runtime/commands/defs/crew.ts`; overlay routing via `seatPickerOverlayFor` in `src/core/navigation/types.ts`; Crew section at `src/features/crew/`, seat and preset models at `src/core/crew/`; effort delivery rules in [`CONFIGURATION.md`](./CONFIGURATION.md).
- **See also**: `/settings`, `/refresh`.

### `/refresh`

- **Purpose**: Re-run tool detection — probes the system for the catalog's installed CLIs (`CLI_TOOL_IDS` in `src/core/runners/cli-tool-catalog.ts`: claude-code, codex, opencode, copilot, kilo-code, cursor, command-code, antigravity), reachable API endpoints (Ollama, LM Studio, llama.cpp), and refreshes the availability cache so newly installed tools become selectable in the seat pickers.
- **Screens**: all.
- **Args**: none.
- **Example**: `/refresh`
- **Behavior**: Immediately prints `"Refreshing tool detection…"`, then reports the outcome of the refresh on completion. Detection runs asynchronously; the picker overlays read from the cache on next open.
- **Implementation**: catalog at `src/core/runtime/commands/defs/crew.ts`; calls `refreshDetection` through the command context.
- **See also**: `/crew`.

---

## Workflow

Commands that act on the active run: stop, resume or end the run, manage the queue, and settle the run's written changes. `category: 'workflow'` in the registry. Most are restricted to the `workflow` screen. A change to the plan is requested on the plan card (the Request changes row); there is no rewind command.

### `/stop`

- **Purpose**: Open the inline session-options menu immediately above the workflow composer — the same menu `Esc` opens on a live run.
- **Screens**: `workflow`.
- **Args**: none.
- **Example**: `/stop`
- **Behavior**: The rows follow the run's state: a live run offers `Stop now`, `Pause after this brief` (or `Keep running` when a pause is pending) and `End run`; a parked or stopped run offers `Resume`, `End run` and `Back to sessions`; a failed stop offers `Retry stop` alone; while this window's Apply writes, the menu offers only `Back to sessions`, which goes home once Apply finishes. `↑↓` selects, `Enter` executes, `Tab` dismisses back to the composer without touching the run or the draft. Nothing stops, resumes or ends until a row is confirmed.
- **Implementation**: catalog at `src/core/runtime/commands/defs/workflow.ts`; rows from `readStopMenuRows` (`src/features/workflow/stop/options.ts`).
- A live run waiting on the recovery panel offers only `Stop now` and `End run`. It cannot finish a brief, so it offers no pause.
- **See also**: `/resume`, `/end`.

### `/resume`

- **Purpose**: Continue a run — one parked by the stop sheet (`Stop now` at a brief, `Pause after this brief` at the boundary) or one left at rest on disk.
- **Screens**: `workflow`.
- **Phase guard**: `isLivePhase(phase)`, or an open run at rest on the screen in any phase — a gate it waits at included (`isOpenRunAtRest`, `src/stores/navigation/router.ts`); elsewhere the feedback line reads `"No run to resume in this phase"`.
- **Args**: none.
- **Example**: `/resume`
- **Behavior**: Calls `ctx.resumeRun()` through `continueRun` (`src/engine/orchestrator/run/continue.ts`). A park held by this process continues in place. A run at rest re-enters its saved step; a closed run is refused. Typed instructions become the step's steer. Bare Enter continues an open run at rest and a run parked in this process. Ready workspace runs instead offer [the result menu](./FEATURES.md#run-result-menu).
- **Implementation**: catalog at `src/core/runtime/commands/defs/workflow.ts`; the park itself is `stopStore` (`src/stores/workflow/stop.ts`).
- **See also**: `/end`, `/quit`.

### `/end`

- **Purpose**: Close the run and preserve unapplied workspace work. See [Apply](./WORKFLOW.md#apply).
- **Screens**: `workflow`.
- **Phase guard**: `isLivePhase(phase)`, or an open run at rest on the screen in any phase — a gate it waits at included (`isOpenRunAtRest`, `src/stores/navigation/router.ts`); elsewhere the feedback line reads `"No run to end in this phase"`. A run at rest whose Apply did not finish is refused (`isApplyUnfinishedAtRest`): the palette, `/help` and `/` completion do not list `/end`, and a typed `/end` reads `"Apply did not finish. Restore or retry Apply first, then end the run."`.
- **Args**: none.
- **Example**: `/end`
- **Behavior**: Calls `ctx.endRun()` through the same close path as the stop menu. End run on a ready workspace run means Discard. Earlier End run closes as `ended`. End run refuses an unfinished Apply: restore or retry Apply first. Session options then offer no End run. The refusal preserves the workspace, Apply backup and recovery. The close path preserves unapplied work before removing the workspace. With no active run, it reports `No active run to end.`. See [Apply](./WORKFLOW.md#apply).
- **Implementation**: catalog at `src/core/runtime/commands/defs/workflow.ts`.
- **See also**: `/resume`, `/run`.

### `/steer <text>`

- **Purpose**: Stop now and continue the run with a correction.
- **Screens**: `workflow`.
- **Args**: The correction text.
- **Example**: `/steer Keep the current files and add the missing check.`
- **Shortcut**: `ctrl+⏎` with text in the composer, also called `ctrl+enter`.
- **Behavior**: `requestSteer` keeps the text until the stop completes, then continues with the text as the step's steer. A terminal without extended keys reports `ctrl+⏎` as Enter, which queues the message. `/steer` works in every terminal.
- **Implementation**: catalog at `src/core/runtime/commands/defs/workflow.ts`; `requestSteer` in `src/features/workflow/handlers.ts`.
- **See also**: `/queue`, `/resume`, `/stop`.

### `/queue [show|clear]`

- **Purpose**: Inspect the queued count or clear messages awaiting first delivery to any seat.
- **Screens**: `workflow`.
- **Delivery**: Enter with text queues a message for the seat of the active stage. See [Message queue](./ENGINE.md#message-queue) for delivery rules, corrections, retries, and verdicts. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for tool support and transport details.
- **Args**: `show` (default when no argument is given) or `clear` (the `QUEUE_ACTIONS` tuple in `src/core/runtime/commands/types.ts`). Any other value prints `"Unknown queue command: <sub>. Use: /queue show or /queue clear"`.
- **Example**: `/queue`, `/queue show`, `/queue clear`.
- **Behavior**: `show` prints `Queue is empty` or the shared byline copy, such as `2 queued for BUILD on T003`. `clear` prints `"Cleared N queued message(s)"` or `"Queue is already empty"`. The queued count drops at first delivery to any seat. A message that REVIEW read also goes to the next fix brief's BUILD call without changing the count again. Clearing removes only messages awaiting first delivery and preserves delivered history. See [Queued count](./ENGINE.md#queued-count).
- **Implementation**: catalog at `src/core/runtime/commands/defs/workflow.ts`; depth read from `lifecycleStore.get().queueDepth`; clearing routes through `requestClearQueue()` in `src/features/workflow/handlers.ts`.
- **See also**: `/steer`, `/stop`.

### `/run accept|reject`

- **Purpose**: Apply or discard an isolated run, undo a completed Apply, or accept or reject a checkout run. Older runs without a recorded workspace keep the snapshot ledger.
- **Screens**: `workflow`, at rest. Apply and rejection are unavailable while the run is active. Rejection refuses closed runs in every isolation mode, except undo of a completed Apply in a worktree or staged-copy run.
- **Args**: `accept` or `reject`. `reject` requires the literal `confirm`. An Accept as is override also requires `accept confirm`.
- **Example**: `/run accept`, `/run accept confirm`, `/run reject confirm`.
- **Behavior on a worktree or staged-copy run**: `accept` starts [Apply](./WORKFLOW.md#apply) when the run is ready to apply. It writes no accepted-run snapshot entry. A changed candidate returns to checks and review; continue the run to start them. Before Apply, `reject confirm` means Discard. Discard refuses an unfinished Apply: restore or retry Apply first. After a completed Apply, `reject confirm` undoes Apply from its backup. It restores only paths that still match the applied result and names later edits it leaves intact. The run stays closed and records the undo; a second undo is refused. See [Partial Apply recovery](./APPROVAL-AND-RECOVERY.md#partial-apply-recovery) for restoring an unfinished Apply.
- **Behavior on a checkout run**: `accept` closes an open run as `ended`, with its current files. A closed run refuses acceptance and rejection. `reject confirm` compares the baseline, the latest recorded run snapshot and the current checkout. The run records a run snapshot after each brief settles and when the run comes to rest, so a run that stopped or halted before its review can also be rejected. It restores or deletes only recorded run changes that still match the run snapshot. A file it recreates gets the mode that the baseline recorded. Later user edits and files outside that recorded change stay untouched. Each rejection is a `Rejected` row in the run's transcript, live and on reopen (the `run_rejected` event): it counts the replaced files it put back and the created files it removed (for example `Put back 1 replaced file, removed 2 created files.`), names up to five paths left as you changed them and counts the rest, and names the saved folder. The feedback line only points at that row. A changed path that now holds a symlink or directory is a conflict. Rejection saves replaced files with their modes under `.splitbrief/sessions/<id>/reverted/<stamp>/`. A rejection with no conflicts or missing snapshot files closes the run as `discarded`; it writes no `run.patch`, and the closed block reads the same counts, summed over every rejection of the run. Otherwise the run stays open. A stopped brief no longer counts the files the rejection put back as its kept partial changes, and the run no longer lists them. A brief that passed and had a file put back is open again: the run waits before the first such brief (`Stopped before T<id>`), and continuing it builds that brief again. This is also true when the run was halted on a later brief or on the final review: that halt ends. You can also reject the run again. Only a run killed before its first brief settled has no recorded run snapshot. Rejection then reports `No run snapshot to reject.` and changes no files.
- **Behavior on an older run**: `accept` seals its snapshot ledger and reports the accepted snapshot id. An open run's `reject confirm` uses the same snapshot comparison as checkout runs. It saves replaced bytes first and records the same `Rejected` row. It reports missing snapshots, accepted runs and later edits instead of overwriting them. A closed run refuses rejection.
- **Implementation**: `src/core/runtime/commands/defs/workflow.ts`, with ports in `src/app/command-context.ts`. Apply and restore live under `src/engine/orchestrator/apply/`. Older snapshot behavior stays in `src/engine/snapshots/run/lifecycle.ts` and `rollback.ts`.

---

## View

Commands that change what the workflow screen shows without touching the run. `category: 'view'` in the registry.

### `/scroll <top|bottom|page-up|page-down>`

- **Purpose**: Move the workflow conversation without relying on terminal-delivered navigation keys.
- **Screens**: `workflow`.
- **Args**: required. `top` jumps to the oldest visible conversation rows, `bottom` returns to live output, `page-up` moves up by one viewport page, and `page-down` moves down by one viewport page (the `SCROLL_COMMAND_TARGETS` tuple).
- **Example**: `/scroll top`, `/scroll bottom`, `/scroll page-up`, `/scroll page-down`.
- **Behavior**: Dispatches the same row-based scroll actions as the keyboard path. This is the guaranteed route when a terminal does not forward `Home`, `End`, `PageUp`, or `PageDown`.
- **Implementation**: catalog at `src/core/runtime/commands/defs/view.ts`; command context reads the conversation scroll snapshot and writes `conversationScrollStore`.
- **See also**: `/activity`, `/sidebar`.

### `/activity`

- **Purpose**: Toggle the latest expandable runner-activity block in the workflow conversation.
- **Screens**: `workflow`.
- **Args**: none.
- **Shortcut**: `Ctrl+A` (`src/core/keybindings/registry.ts`); `/activity` is the guaranteed command path.
- **Example**: `/activity`
- **Behavior**: Expands the most recent compact activity block with hidden rows, or collapses it if it is already expanded. Collapsed activity blocks show a compact key affordance such as `ctrl+a` when earlier rows are hidden. If no activity block has hidden rows, the feedback line says so.
- **Implementation**: catalog at `src/core/runtime/commands/defs/view.ts`. The command context selects a target from `readConversationRowActions()` with `findLatestConversationRowAction()`, then calls `conversationScrollStore.toggleActivityBatch()`.
- **See also**: `/scroll`, `/diff`.

### `/sidebar`

- **Purpose**: Show or hide the workflow sidebar.
- **Screens**: `workflow`.
- **Args**: none.
- **Example**: `/sidebar`
- **Behavior**: Toggles the workflow sidebar and reports `"Sidebar shown"` or `"Sidebar hidden"` on the feedback line. On small terminals the command reports that the sidebar is hidden instead of claiming it was shown. There is no global shortcut so normal composer text-editing chords stay unclaimed.
- **Implementation**: catalog at `src/core/runtime/commands/defs/view.ts`; command context toggles `controlsStore.sidebarVisible`.
- **See also**: `/scroll`, `/activity`.

### `/tasks`

- **Purpose**: Show the brief list. The advertised way to reach every brief at any width, so the list is never behind a chord the legend does not name.
- **Screens**: `workflow`.
- **Args**: none.
- **Example**: `/tasks`
- **Behavior**: Names a destination rather than a switch: it shows the sidebar and a second call leaves it on screen (the sidebar primitive is a toggle, so a toggle that hid it is undone), then reports `"Brief list shown"`. At or below 120 columns there is no sidebar to open, so the command answers with the list itself — `"Briefs: T001 passed, T002 running, T003 queued"`, or `"No briefs planned yet"` before the plan lands — and settled briefs appear as rows in the transcript. The queued block lists pending briefs.
- **Implementation**: catalog at `src/core/runtime/commands/defs/view.ts`; toggles `controlsStore.sidebarVisible` through the command context, and reads the briefs from `tasksStore` through the context's `listBriefs` port.
- **See also**: `/sidebar`, `/scroll`.

### `/usage`

- **Purpose**: Open reported token usage and monetary estimates explicitly.
- **Screens**: `workflow`, live or at rest.
- **Args**: none.
- **Example**: `/usage`
- **Behavior**: Opens the `usage-details` overlay for the current run. Missing or partial usage remains labelled; unknown pricing is not zero cost. Closing the details returns to a workflow without token or cost counters.
- **Implementation**: `src/core/runtime/commands/defs/view.ts`, `src/app/overlays/usage.tsx`.
- **See also**: `/sessions`, `/copy`.

### `/diff`

- **Purpose**: Expand or collapse the latest diff block in the workflow conversation — the command mirror of `Ctrl+D`.
- **Screens**: `workflow`.
- **Args**: none.
- **Shortcut**: `Ctrl+D` (`src/core/keybindings/registry.ts`).
- **Example**: `/diff`
- **Behavior**: Prints `"Expanded latest diff"` or `"Collapsed latest diff"`. Targets include diffs, cut failure causes, drift findings, and automatic Recovery details. The keyboard, palette, and slash command select the same row across the whole transcript. With no expandable target, the feedback line says why.
- **Implementation**: catalog at `src/core/runtime/commands/defs/view.ts`. The command context uses the same row-action selection as `/activity`, then calls `conversationScrollStore.toggleDiff()`.
- **See also**: `/activity`, `/copy` (`/copy cost`).

---

## Input & output

Commands that move data in or out: clipboard copies and image attachments. `category: 'io'` in the registry.

### `/copy [message|brief|path|command|cost]`

- **Purpose**: Copy a value you are reviewing to the system clipboard, so you do not have to select terminal text. Grabs the planner's last message, a Task Brief, a brief's file path, the planner command, or the cost summary.
- **Screens**: `workflow` only. Not available on `home` — copy targets read workflow review state.
- **Args**: optional target. One of `message`, `brief`, `path`, `command`, `cost` (the `COPY_TARGETS` tuple in `src/core/runtime/commands/types.ts`). Defaults to `message` when omitted. Any other value prints `"Invalid copy target: <x>. Valid: message, brief, path, command, cost"`.
  - `message` — the planner's most recent assistant text.
  - `brief` — the source text of the Task Brief at the top of the visible window.
  - `path` — the file path of the brief at the top of the visible window, relative to the project directory.
  - `command` — the configured planner runner command.
  - `cost` — an explicit export of available cost details; it reads the same spend text as `/usage`, and the legacy `workflow.showSpend` key does not switch it off. There is no Settings toggle or main-screen counter.
- **Example**: `/copy`, `/copy brief`, `/copy path`, `/copy cost`
- **Behavior**: Resolves the raw value (never the sanitized display copy) and writes it to the clipboard. When the target has no value the feedback line reads `"Nothing to copy"`. A confirmed native or tmux copy reads `"Copied (native)"` / `"Copied (tmux-buffer)"`; an OSC-52 escape the terminal may silently drop reads `"Copy escape sent; verify your clipboard (some terminals block it)"`; a failure reads `"Could not copy"`.
- **Implementation**: catalog at `src/core/runtime/commands/defs/io.ts`; value resolution in `src/features/workflow/copy/resolve.ts`; clipboard delivery in `src/lib/clipboard/clipboard.ts`.
- **See also**: `/image`.

### `/image <path>|list|remove`

- **Purpose**: Attach, list, or remove images (PNG, JPG, etc.) for the next planner call. Useful for "here is a screenshot of the bug" workflows.
- **Screens**: `home`, `workflow`.
- **Guard**: the PLAN seat must be able to see images. Without vision, the dispatcher refuses `/image` before its handler runs. It reports `"PLAN seat cannot see images — pick a vision model with /crew plan"`. Whether a seat can see images depends on its runner (`seatSupportsImages`, `src/core/runners/capabilities.ts`, and `imageInput` in `src/core/runners/cli-tool-catalog.ts`):

  | PLAN seat | Images |
  |---|---|
  | `cli` Claude Code | yes, as image content blocks on stdin |
  | `cli` Codex, OpenCode, Copilot, Kilo Code | yes, as a file flag |
  | `cli` Cursor, Command Code, Antigravity | no |
  | `api` | only when detection reports the model as vision-capable; a model that detection did not report cannot |
  | `shell`, `agent` | no |

- **Composer feedback**: Drop, paste, and sending a resolved `@x.png` use the composer's vision check. With a loaded configuration, each reports `"Cannot attach: PLAN seat <seat identity> cannot see images — /crew plan"`. Without a loaded configuration, drop and paste report `"Cannot attach image: the planner cannot see images. Choose a vision model with /crew plan."`. Without a loaded configuration, sending `@x.png` reports `"Cannot send image: the planner cannot see images. Choose a vision model with /crew plan."`.
- **Args**: a file path, or one of `list` / `remove` (the `IMAGE_ACTIONS` tuple in `src/core/runtime/commands/types.ts`). No argument behaves like `list`; `remove` takes a 1-based index or the attachment's ID.
- **Example**: `/image ./screenshots/bug.png`, `/image list`, `/image remove 1`, `/image remove att_a8f3c2`
- **Behavior**:
  - `list` (or no argument) with nothing pending: `"No image attachments pending. Usage: /image <path>"`; otherwise `"Pending attachments: 1: <path>, 2: <path>"`.
  - A path on success: `"Attached: <resolved-path>"`. File refusals use the messages below. Composer drop uses the same messages. Only refused composer sends append ` File: <base name>.`, with at most 24 terminal cells for the base name. Sending the directory reference `@/Users/me/notes/` reports `"Cannot send: not a regular file. Name a file, not a directory. File: notes."`.
  - `remove` without a target: `"Usage: /image remove <index|id>"`. On success `"Removed: <input>"`, on no match `"No attachment matched: <input>"`.

| Reason | Feedback |
|---|---|
| `not-found` | `Cannot attach image: file not found. Check the path and try again.` |
| `not-a-file` | `Cannot attach image: not a regular file. Name a file, not a directory.` |
| `too-large` | `Cannot attach image: file is larger than 10 MiB. Choose a smaller file.` |
| `unreadable` | `Cannot attach image: cannot read the file. Check its permissions.` |
| `not-image` | `Cannot attach image: choose a PNG, JPEG, GIF, WebP, or BMP file.` |

- **Implementation**: catalog at `src/core/runtime/commands/defs/io.ts`; attachment helpers in `src/stores/workflow/attachments.ts`, backed by `src/core/attachments/resolve.ts`.
- **See also**: `/crew`.

---

## Removed

These names no longer exist. Typing one prints `"<name> was removed: <pointer>"` instead of `Unknown command`, for one release (`REMOVED_COMMANDS` in `src/core/runtime/commands/types.ts`).

| Removed | Pointer |
|---|---|
| `/attach` | `images are attached with /image <path>` — see [`/image`](#image-pathlistremove). |
| `/detach` | `images are removed with /image remove <index\|id>` — see [`/image`](#image-pathlistremove). |
| `/effort` | `effort is chosen with the model: /crew plan, then ⏎` — reasoning effort is chosen with the model in the seat picker; delivery per runner kind is documented in [`CONFIGURATION.md`](./CONFIGURATION.md). |
| `/repomap` | `the repo map rebuilds itself on each planning run, with no manual step` — background on the map in [`REPOMAP.md`](./REPOMAP.md). |
| `/accept-run` | `a run is accepted with /run accept` — see [`/run`](#run-acceptreject). |
| `/reject-run` | `a run is rejected with /run reject confirm` — see [`/run`](#run-acceptreject). |
| `/config` | `the same settings open with /settings` — see [`/settings`](#settings). |
| `/planner` | `the PLAN seat is chosen with /crew plan` — see [`/crew`](#crew-planbuildreview). |
| `/implementer` | `the BUILD seat is chosen with /crew build` — see [`/crew`](#crew-planbuildreview). |
| `/reviewer` | `the REVIEW seat is chosen with /crew review` — see [`/crew`](#crew-planbuildreview). |
| `/compact-transcript` | `the transcript compacts itself as the context window fills` — compaction is automatic; the format is `workflow.compactionFormat` in [`CONFIGURATION.md`](./CONFIGURATION.md). |
| `/export` | `a run leaves its artifacts in .splitbrief/sessions/<id>/` — there is no HTML report; read the session directory. |
| `/handoff` | `a run leaves its artifacts in .splitbrief/sessions/<id>/` — there is no handoff pack; read the session directory. |
| `/yolo` | `only a write to a protected path asks` — `approval.enabled` loads with one retirement notice and is ignored; `--yolo` is removed; see `approval` in [`CONFIGURATION.md`](./CONFIGURATION.md#9-approval). |
| `/mode` | `every run plans in one session` — there are no workflow modes; see [WORKFLOW.md](./WORKFLOW.md#3-the-planning-session). |
| `/revise-spec` | `request changes on the plan` — on the plan card, the Request changes row (or a typed `comment <text>`) sends the correction to the planning session. |
| `/revise-plan` | `request changes on the plan` — on the plan card, the Request changes row (or a typed `comment <text>`) sends the correction to the planning session. |
| `/approval` | `a protected write asks once per run` — there are no sticky grants to list or clear; see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation). |

---

## Keyboard shortcuts

Most slash commands have no dedicated keybinding — open the command palette with `Ctrl+K` and type. The keys below are bound directly in the input handlers (`src/app/keys.ts`, `src/features/workflow/hooks/use-keys.ts`) and run without going through the slash dispatcher.

### Global (any screen)

| Key | Action | Source |
|---|---|---|
| `Ctrl+K` | Open command palette | `src/app/keys.ts` |
| `Ctrl+/` | Open help overlay (sent as control character `\x1f`) | `src/app/keys.ts` |
| `Ctrl+,` | Open settings overlay | `src/app/keys.ts` |
| `Ctrl+Q` | Stop the run safely, save the session, exit | `src/app/keys.ts` |
| `Ctrl+C` | On a live run, the first press is Stop now and arms a two-second quit confirmation; on other screens it only arms the confirmation. A second press within two seconds, or while the stop still runs, quits after cleanup and saving. While this window's Apply writes, the first press quits once Apply finishes | `src/app/keys.ts` |
| `Esc` | Open the stop menu (live workflow); a second Escape stops now; once the run is stopping or parked, the next Escape goes home; go home on a run at rest; while this window's Apply writes, go home once Apply finishes; otherwise close the topmost overlay | `src/app/keys.ts` |

`Ctrl+C` is Stop now while a run can still be stopped: one press performs **Stop now** (`requestStopNow` in `src/features/workflow/handlers.ts`), aborting the in-flight call along with any retry, consult or per-task review call, scheduling no new brief, and parking the run as `Stopped at T<id>`, followed by `· Partial changes kept` when the brief had already changed files. It is also how you quit, and that press is confirmed: the first press arms a two-second `Press ctrl+c again to quit` confirmation — on a live run, the press that stops it is the one that arms it. The next press within the window quits, and so does a press while the stop is still running. Quit waits for cleanup and saving before it exits (`requestQuit`). Any other interaction clears the confirmation.

`Esc` during a live workflow opens the **Stop options** menu immediately above the composer (`src/features/workflow/stop/menu.tsx`), with or without a draft. The transcript stays visible and updates. `↑↓` selects, `Enter` executes, a second `Esc` performs resumable **Stop now**, and `Tab` dismisses. Once the run is stopping or parked, the next `Esc` goes home after cleanup and saving, so a fast `esc esc esc` stops the run and leaves it. **End run** stays an explicit selection. The pause row appears while a brief is running and becomes **Keep running** when a pause is pending. The title line promises `Changes and draft stay.` once the run has changes to keep, and `Draft stays.` before any brief has run or after a stop that cut a brief before it wrote a file while no brief had finished; every row shows its consequence in full. `Ctrl+C` remains immediate Stop now. Completion, editor and permission dialogs retain their own Escape handling, and so does a comment typed on the plan card: the first `Esc` clears it and returns the keys to the card rows. On an inactive run, Escape goes home, draft or no draft. While this window's Apply writes to your checkout, live or at rest, Escape opens no menu and stops nothing: it goes home once Apply finishes, and the byline reads `Returns home when Apply finishes`. `Ctrl+C` then queues the quit behind Apply in the same way.

### Home screen only

| Key | Action | Source |
|---|---|---|
| `Ctrl+S` | Rescan skill sources and open the skills overlay | `src/app/keys.ts` |
| `Ctrl+R` | Focus the recent sessions list | `src/features/home/use-recent-sessions-focus.ts` |

### Workflow screen

These keys are handled in `src/features/workflow/hooks/use-keys.ts` and routed through pure functions in `src/features/workflow/keyboard.ts`. Conversation keys take effect only when no overlay is open and the input mode is `normal`.

macOS terminals do not always forward physical `PageUp`, `PageDown`, `Home`, or `End` without an `Fn` layer. In normal workflow input, the composer owns text-editing chords such as `Ctrl+B`, `Ctrl+E`, and `Ctrl+F`, so `/scroll` is the reliable command path for conversation paging.

| Key | Action | Source |
|---|---|---|
| `Enter` with text | Queue a message for the active stage's seat while the run is live | composer submit handler |
| `ctrl+⏎` with text | Stop now and continue with the text, like `/steer <text>` | composer submit handler, `requestSteer` |
| `Ctrl+D` | Toggle the most recent diff in the conversation | `keyboard.ts` `handleWorkflowCtrlChords` |
| `Esc` | Open the stop menu while a run is live; go home once the run is stopping or parked, and on a run at rest | `src/app/keys.ts` |
| `Shift+↑` | Scroll conversation up by one line | `keyboard.ts` `handleConversationScroll` |
| `Shift+↓` | Scroll conversation down by one line | `keyboard.ts` `handleConversationScroll` |
| `PageUp` | Scroll conversation up by one page | `keyboard.ts` `handleConversationScroll` |
| `PageDown` | Scroll conversation down by one page | `keyboard.ts` `handleConversationScroll` |
| `Home` | Jump to top of conversation | `keyboard.ts` `handleConversationScroll` |
| `End` | Jump to bottom of conversation | `keyboard.ts` `handleConversationScroll` |
| `/scroll top` | Command path to jump to top of conversation | runtime command registry |
| `/scroll bottom` | Command path to jump to bottom of conversation | runtime command registry |
| `/scroll page-up` | Command path to scroll conversation up by one page | runtime command registry |
| `/scroll page-down` | Command path to scroll conversation down by one page | runtime command registry |
| `Ctrl+A` | Expand or collapse the latest hidden activity rows | `keyboard.ts` `handleWorkflowCtrlChords` |
| `/activity` | Expand or collapse the latest hidden activity rows | runtime command registry |

### Review pane (workflow screen, when a file is open)

When the review pane has a `filePath` set (the plan card's `plan.md`), these keys scroll the review content instead of the conversation. They are handled before the conversation-scroll path:

| Key | Action | Source |
|---|---|---|
| `Shift+↑` | Scroll review pane up one line | `keyboard.ts` `handleReviewScroll` |
| `Shift+↓` | Scroll review pane down one line | `keyboard.ts` `handleReviewScroll` |
| `PageUp` | Scroll review pane up by one page | `keyboard.ts` `handleReviewScroll` |
| `PageDown` | Scroll review pane down by one page | `keyboard.ts` `handleReviewScroll` |
| `Ctrl+B` | Fallback scroll review pane up by one page | `keyboard.ts` `handleReviewScroll` |
| `Ctrl+F` | Fallback scroll review pane down by one page | `keyboard.ts` `handleReviewScroll` |
| `Home` | Jump to top of review pane | `keyboard.ts` `handleReviewScroll` |
| `End` | Jump to bottom of review pane | `keyboard.ts` `handleReviewScroll` |

### The plan card

While the plan card waits, `↑`/`↓` move the cursor over its rows and a bare `⏎` takes the highlighted row. The rows carry no letter keys, because the composer holds the keyboard: a letter is text, and a word settles the card only when it is sent with `⏎`. The panel legend reads `approve · comment <text> · end-run · edit` (`REVIEW_HINT`). Typed text goes through `src/features/workflow/review-commands.ts`; any text that is not one of the words below is a correction, so a sentence that opens with `q` or `y` never ends or approves the run.

| Typed | Action |
|---|---|
| `approve` / `y` / `yes` / `ok` / `lgtm` / `continue` | Approve the plan |
| `c` / `comment` | Open an empty change request: the next text you send is the correction, whatever word it starts with |
| any other text, `comment <text>` / `revise <text>` | Request changes: the planning session answers the correction with a new plan, and the card shows again |
| `Ctrl+E` / `e` / `edit` / `edit-file` | Open `plan.json` in the in-app editor |
| `end-run` / `end` / `q` / `quit` / `reject` / `no` | End the run |

### Inline editor (`plan.json`)

`Ctrl+E`, `e` and `edit` at the plan card all open the same file, the run's `plan.json`, in a full-surface exclusive overlay (`src/features/workflow/review-editor.ts`). The editor is protocol-free and single-owner — while it is open it owns keyboard input and no other handler competes. `Ctrl+S` checks the text before it writes: the JSON, the plan schema and `checkPlan` (the engine checks the context fit after the save). A text that fails stays open with one red row, `Not saved: <first message> (+N more)`. A valid save writes `plan.json`, closes the editor and settles the card with the edit; the engine compiles the edited plan and shows the card again, or restores `plan.json` and publishes `The edited plan was not applied: …`.

The keymap is protocol-free and is the single source of truth in [`src/core/keybindings/editor.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/keybindings/editor.ts) (`resolveEditorKeyAction`); the chords below are asserted against that resolver by [`src/core/keybindings/editor.test.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/keybindings/editor.test.ts) so this table cannot drift.

| Key | Action |
|---|---|
| `Enter` / `Ctrl+J` | Insert a newline (Enter never commits) |
| `Ctrl+S` | Save |
| `Esc` | Cancel (discard, close the editor) |
| `Ctrl+O` | Open `plan.json` in the external editor (pre-saves the buffer, CAS-guarded); saving there settles the plan card with the edit |
| `Alt+C` / `Ctrl+Y` | Copy selection |
| `Alt+X` / `Ctrl+X` | Cut selection |
| `Alt+A` | Select all |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `←` / `→` | Move caret one grapheme (collapses selection) |
| `Shift+←` / `Shift+→` | Extend selection by one grapheme |
| `Alt+←/→` or `Ctrl+←/→` | Move by word (add `Shift` to select) |
| `↑` / `↓` | Move caret by visual row |
| `Home` / `End` | Move to start / end of the current visual row |
| `Ctrl+Home` / `Ctrl+End` | Move to start / end of the document |
| `PageUp` / `PageDown` | Move by one viewport page |
| `Backspace` / `Delete` | Delete one grapheme (add `Ctrl`/`Alt` to delete a word) |

`Shift` combined with any motion (`←/→`, word, `Home`/`End`, `Ctrl+Home`/`Ctrl+End`, `PageUp`/`PageDown`) extends the selection; the same motion without `Shift` collapses it. `Ctrl+C` is **never** mapped to copy, cut, or select-all — it keeps its stop / exit semantics (copy is `Alt+C` or `Ctrl+Y`), so the editor cannot swallow the stop chord. `Home`, `End`, `PageUp`, and `PageDown` are recaptured as editor motions while the exclusive overlay is open rather than being surrendered to the conversation transcript.

When the `Ctrl+O` external editor is used instead, `VISUAL` takes precedence over `EDITOR` in editor resolution ([`src/features/workflow/editor-command.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/features/workflow/editor-command.ts) `resolveEditorArgv`); this precedence is asserted by [`src/features/workflow/editor-command.test.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/features/workflow/editor-command.test.ts).

### A run at rest

The workflow screen is also the run's home at rest. An open run takes a correction; bare Enter continues it. A ready run uses [the result menu](./FEATURES.md#run-result-menu), with Tab switching focus. Its composer takes slash commands. A closed run also takes slash commands; bare Enter goes home. Escape leaves a run at rest for home without opening the stop menu.

---

## Cross-reference: shortcuts declared in the keybinding registry

The `SHORTCUTS` table in `src/core/keybindings/registry.ts` is the single source of truth for the labels rendered next to slash commands in the help overlay and command palette. Some entries are advisory (the actual handler is elsewhere), but the registry is what the UI reads:

| ID | Key | Description | Screens |
|---|---|---|---|
| `exit` | `ctrl+c` | Stop; press again to quit | workflow |
| `exit` | `ctrl+c` | Press twice to quit | home, setup |
| `command-palette` | `ctrl+k` | Command palette | all |
| `help` | `ctrl+/` | Help | all |
| `quit` | `ctrl+q` | Quit | all |
| `stop` | `esc` | Options → stop → back to sessions | workflow |
| `recent-sessions` | `ctrl+r` | Focus recent sessions | home |
| `skills` | `ctrl+s` | Skills picker | home |
| `settings` | `ctrl+,` | Settings | all |
| `close-overlay` | `esc` | Close overlay | home, setup |
| `toggle-diff` | `ctrl+d` | Toggle diff | workflow |
| `scroll` | `shift+↑/↓, pgup/pgdn, home/end` | Scroll; PageUp/PageDown; /scroll top\|bottom | workflow |
| `review-edit` | `ctrl+e` | Open editor in review mode only | workflow |
| `activity` | `/activity, ctrl+a` | Expand activity rows | workflow |

---

## Index by command name

Alphabetical, for fast lookup.

- [`/activity`](#activity) — expand or collapse the latest hidden activity rows.
- [`/copy`](#copy-messagebriefpathcommandcost) — copy a reviewed value to the system clipboard.
- [`/crew`](#crew-planbuildreview) — change who fills the `PLAN`, `BUILD`, or `REVIEW` seat.
- [`/diff`](#diff) — expand or collapse the latest diff.
- [`/end`](#end) — close the run, saving unapplied changes.
- [`/help`](#help) — open the help overlay.
- [`/home`](#home) — navigate to the home screen.
- [`/image`](#image-pathlistremove) — attach, list, or remove images for the next planner call.
- [`/palette`](#palette) — open the command palette.
- [`/queue`](#queue-showclear) — inspect or clear messages awaiting first delivery to any seat.
- [`/quit`](#quit) — exit the application.
- [`/refresh`](#refresh) — re-run tool detection.
- [`/resume`](#resume) — continue a paused or stopped run.
- [`/run`](#run-acceptreject) — accept or roll back what this run wrote.
- [`/scroll`](#scroll-topbottompage-uppage-down) — move the workflow conversation by command.
- [`/sessions`](#sessions) — browse past sessions.
- [`/settings`](#settings) — open the settings overlay (Crew first).
- [`/sidebar`](#sidebar) — show or hide the workflow sidebar.
- [`/stop`](#stop) — open the inline session-options menu.
- [`/skills`](#skills) — pick skills for every seat, bare or by id.
- [`/steer`](#steer-text) — stop now and continue with a correction.
- [`/tasks`](#tasks) — show the brief list.
- [`/usage`](#usage) — open token and monetary details for the run.

---

## See also

- [`FEATURES.md`](./FEATURES.md#slash-commands-palette) — the shorter overview document, useful as a quick refresher.
- [`docs/WORKFLOW.md`](./WORKFLOW.md) — workflow phases, the planning session, and the plan card.
- [`docs/CONCEPTS.md`](./CONCEPTS.md) — shared vocabulary (phase, queue, run status, stop reason, step, etc.).
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the TUI, stores, engine, and runners are layered.
- [`docs/STORES.md`](./STORES.md) — `configStore`, `overlayStore`, `feedbackStore`, `lifecycleStore`, `routerStore`, `attachmentsStore`.
- [`src/core/runtime/commands/`](https://github.com/b4r7x/splitbrief/tree/main/src/core/runtime/commands) — `dispatch.test.ts`, `lookup.test.ts`, and split `registry-*.test.ts` suites (`registry-configuration.test.ts`, `registry-recovery.test.ts`, `registry-conversation.test.ts`, `registry-copy.test.ts`, `registry-snapshots.test.ts`, …) cover the phase / screen / arg matrix.
