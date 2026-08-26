# Slash Commands Reference

The complete reference for every slash command available in the SPLITBRIEF TUI. This document is the exhaustive lookup — every entry in [`src/core/runtime/commands/registry.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/registry.ts) is documented here, grouped by purpose, with usage, screen availability, behaviour, and cross-references.

If you only want a short overview, see [`FEATURES.md`](./FEATURES.md#slash-commands-palette). If you are adding a new command, follow the contract in [`src/core/runtime/commands/types.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/types.ts) and the dispatch rules in [`src/core/runtime/commands/dispatch.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/dispatch.ts).

## How dispatch works

Type `/` in the TUI to open the command picker. Dispatch inside `src/core/runtime/commands/dispatch.ts` resolves commands in three steps:

1. Exact match on `name` or any `aliases`. An alias may carry an argument: `/config` resolves to `/settings`, `/reviewer` to `/crew review`. See [Aliases](#aliases).
2. If no exact match, a removed name gets a pointer to its replacement (`removedCommandPointer`, `src/core/runtime/commands/lookup.ts`) — see [Removed](#removed).
3. Otherwise `suggestRuntimeCommand` in the same module may suggest a close command in the error message — it does not auto-execute. Example: `/mde` returns `Unknown command: /mde. Did you mean /mode?` without running `/mode`.

Each command declares `validScreens`. The screens are `home`, `workflow`, `summary`, and `setup` (`src/core/navigation/types.ts`). Invoking a command on the wrong screen surfaces an error through the `feedbackStore`. The constant `ALL_SCREENS` (`src/core/navigation/types.ts`) is shorthand for "available everywhere". Attached clients use `ATTACHED_AVAILABLE_COMMANDS` as an allow-list for completion, palette, and help so config/workflow mutations cannot report false local success (see [Attached clients](#attached-clients-start---detach) below).

Each command may also declare a `guard`, which returns one true sentence when the command cannot run right now (wrong phase, no vision on the PLAN seat) and `undefined` otherwise. The command palette and the composer `/` picker hide guarded-out rows; help lists every command valid for the screen. The rewind predicates are the single source of truth for when a rewind can run:

- `canReviseSpec(phase)` — `src/core/phases.ts` (called at `src/core/runtime/commands/registry.ts:278`) — true once the spec is written (`reviewing-spec` and later, except `idle`/`complete`).
- `canRevisePlan(phase)` — `src/core/phases.ts` (called at `src/core/runtime/commands/registry.ts:294`) — true once the plan is written (`reviewing-plan`, `reviewing-briefs`, and later).
- `canRedoTask(phase)` — `src/core/phases.ts` (called at `src/core/runtime/commands/registry.ts:311`) — true only during `implementing`, `validating-task`, or `escalating`.

Handlers reach the engine and stores through the `RuntimeCommandContext` interface in `src/core/runtime/commands/types.ts`, assembled by `createCommandContext` in `src/core/runtime/commands/context-factory.ts` — every config write goes through its `saveConfig` path; the TUI (`src/app/command-context.ts`) and the RPC dispatcher only supply the callbacks. The registry itself never imports stores directly; this keeps the command list testable in isolation (see `src/core/runtime/commands/dispatch.test.ts`).

### Attached clients (`start --detach`)

When the workflow route carries an `attach` socket (`routerStore` → `route.attach`), the TUI is a thin viewer over a detached IPC server (`src/engine/ipc/server-entry.ts` → `runWorkflowLoop`). `buildCommandContext` sets `ctx.isAttached`, and `createRuntimeCommands` exposes only `ATTACHED_AVAILABLE_COMMANDS` (`src/core/runtime/commands/registry.ts`) in completion, palette, and help.

| Hidden command | Why | Server-side equivalent |
|---|---|---|
| `/revise-spec`, `/revise-plan`, `/redo-task` | Rewind mutates orchestrator state on the server | Type the revision as composer text (`user_input` IPC) or approve/reject at the next prompt |
| `/image` | Pending image attachments live in the client's `attachmentsStore` | Attach before `start --detach`, or restart without detach |
| `/yolo` | Toggles tiered approvals in local config | Change `approval.enabled` in config and restart the server |

Commands that stay available either affect local UI only (`/scroll`, `/copy`, `/sidebar`) or have an explicit IPC bridge:

| Command | IPC message | Handler |
|---|---|---|
| Composer text (normal mode) | `user_input` | `useIpcClient.sendUserInput` → `workflow-bridge.onUserInput` |
| `/queue clear` | `queue_clear` | `useIpcClient.clearQueue` → `workflow-bridge.onQueueClear` (routed in `src/app/screens/workflow.tsx` before dispatch) |
| Approval / question prompts | `prompt_response` | `useIpcClient` prompt handler → `workflow-loop/prompts.ts` (`makeCallbacks`) |

Commands outside that allow-list are unavailable while attached. In particular, config-mutating commands such as `/settings`, `/mode`, and `/crew` are hidden so the attached client cannot claim a detached server setting changed when only local config would have changed.

The slash commands — enumerated by [`src/core/runtime/commands/registry.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/runtime/commands/registry.ts), the single source of truth — are 27 commands. Every one declares a `category` from the closed set in `src/core/runtime/commands/types.ts` — `navigate`, `crew`, `workflow`, `view`, `io` — and is in exactly one; the command palette and the sections below group by it.

---

## Navigate

Commands that open an overlay or change which screen is active. `category: 'navigate'` in the registry; the command palette renders them under **Navigate**.

### `/help`

- **Purpose**: Open the help overlay — key bindings and every slash command valid for the current screen, in one flat list.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+/` (`src/core/keybindings/registry.ts`).
- **Example**: `/help`
- **Behavior**: Opens the `help` overlay. Command rows are filtered by `validScreens` only, so a command that is guarded out in the current phase is still listed. Press `Esc` to close.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/palette`.

### `/palette`

- **Purpose**: Open the command palette — a searchable, keyboard-driven list of every palette-eligible slash command. Useful when you don't remember the exact command name.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+K` (`src/core/keybindings/registry.ts`).
- **Example**: `/palette`
- **Behavior**: Opens the `command-palette` overlay. `/palette` itself is `hidden`, so it is typeable but never listed inside the palette. Palette sources are assembled in `src/features/palette/sources.ts` from labeled runtime commands, workflow modes, live tasks, recent sessions, and `palette.customActions` from config. With an empty query the rows are grouped by `category`. `Enter` on a command that takes an argument prefills `/name ` in the composer instead of running it bare.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/help`.

### `/skills`

- **Purpose**: Pick planner skills for the upcoming session. Skills are pre-canned planner persona / instruction bundles that bias the planner toward specific kinds of work (testing, refactoring, security review, etc.).
- **Screens**: `home` only — skills can only be selected before a workflow starts.
- **Args**: none.
- **Shortcut**: `Ctrl+S` (home screen only — see `src/core/keybindings/registry.ts`).
- **Example**: `/skills`
- **Behavior**: Opens the `skills` overlay. Selection applies to the current home-screen session only and is not written to `config.yaml`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/settings`, `/crew`.

### `/sessions`

- **Purpose**: Browse summary-backed past sessions. Opens the sessions overlay backed by `.splitbrief/sessions/` so you can resume interrupted runs or inspect completed runs.
- **Screens**: all.
- **Args**: none.
- **Example**: `/sessions`
- **Behavior**: Opens the `sessions` overlay. Selecting an interrupted session loads workflow state directly; selecting a completed session opens its summary. Failed sessions without summaries show feedback instead.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/handoff`, `/home`.

### `/settings` (alias `/config`)

- **Purpose**: Open the settings overlay — Crew, validation, workflow defaults, hooks, OTel. The catch-all configuration UI.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+,` (`src/core/keybindings/registry.ts`).
- **Aliases**: `/config`.
- **Example**: `/settings`, `/config`
- **Behavior**: Opens the `settings` overlay. **Crew is the first section**: the three seats (`PLAN`, `BUILD`, `REVIEW`), the escalation branch, and per-seat effort live there, not in separate per-seat sections. Everything below it is the ordinary settings list. Mutations are persisted to project config on save.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/crew`, `/mode`, `/skills`.

### `/home`

- **Purpose**: Navigate back to the home screen from the workflow or summary screen. Leaving an active workflow unmounts the workflow UI and aborts the active run.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/home`
- **Behavior**: Calls `routerStore.navigate({ to: 'home' })`. The home screen shows the prompt input and recent sessions.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; navigation wiring at `src/app/command-context.ts`.
- **See also**: `/sessions`, `/quit`.

### `/quit`

- **Purpose**: Exit the application immediately. The TUI tears down, any in-flight subprocesses are killed via the process registry.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+Q` (`src/core/keybindings/registry.ts`). Also `Ctrl+C` twice within 2 seconds.
- **Example**: `/quit`
- **Behavior**: Calls the `exit` callback wired in `src/app/command-context.ts`. No confirmation prompt — use `/home` if you only want to leave the workflow screen.
- **Implementation**: catalog in `src/core/runtime/commands/registry.ts`.
- **See also**: `/home`.

---

## Crew

Commands that decide who does the work and how: the three seats, the workflow mode, and tool detection. `category: 'crew'` in the registry.

### `/mode [name]`

- **Purpose**: Switch workflow mode at runtime. With no argument, opens the mode-selector overlay so you can pick interactively. With a valid mode name, persists the selection so subsequent runs inherit it.
- **Screens**: all (`home`, `workflow`, `summary`, `setup`).
- **Args**: optional. Valid values: `instant`, `quick`, `standard`, `speckit` (the `WORKFLOW_MODES` tuple in `src/core/schemas/enums.ts`). Invalid values print `"Invalid mode: <x>. Valid modes: instant, quick, standard, speckit"`.
- **Example**: `/mode`, `/mode speckit`, `/mode instant`
- **Behavior**: Successful save prints `"Workflow mode set to: <mode>"`. Failure to save (typically a malformed config file) surfaces the underlying error on the feedback line. Mode semantics live in `docs/WORKFLOW.md` §3.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; persistence in `src/core/runtime/commands/context-factory.ts` — `createCommandContext` owns the `saveConfig` path every config-writing command goes through, and the app and RPC builders only supply the `saveConfig` callback.
- **See also**: `/settings`, `/crew`.

### `/crew [plan|build|review]`

- **Purpose**: Change who fills a seat. One command for all three seats — `PLAN`, `BUILD`, `REVIEW`.
- **Screens**: all.
- **Args**: optional. One of `plan`, `build`, `review` (the `CREW_SEAT_IDS` tuple in `src/core/crew/identity.ts`, re-exported for commands as `CREW_COMMAND_SEATS`). Any other value prints `"Unknown seat: <x>. Valid: plan, build, review"`.
- **Example**: `/crew`, `/crew plan`, `/crew build`, `/crew review`
- **Behavior**: Opens the `settings` overlay focused on the Crew section with the cursor on that seat (`seat:<id>`); with no argument the cursor lands on `plan`. Each seat row reads as one identity — tool then model, separated by ` · ` (for example `Claude Code CLI · Claude Sonnet 4`) — with the billing posture beside it. `Enter` on a seat opens that seat's picker and returns to Crew with the seat updated. Per-seat reasoning effort is edited on the seat here; there is no separate effort command. With no `reviewer` block configured, `REVIEW` reads as inherited from the planner. The escalation branch hangs under `BUILD` when the escalation tier is on.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; Crew section at `src/features/crew/`, seat and preset models at `src/core/crew/`; effort delivery rules in [`CONFIGURATION.md`](./CONFIGURATION.md).
- **See also**: `/settings`, `/refresh`.

### `/refresh`

- **Purpose**: Re-run tool detection — probes the system for installed CLIs (claude-code, codex, opencode, aider, copilot, kilo-code), reachable API endpoints (Ollama, LM Studio, OpenRouter, etc.), and refreshes the availability cache so newly installed tools become selectable in the seat pickers.
- **Screens**: all.
- **Args**: none.
- **Example**: `/refresh`
- **Behavior**: Immediately prints `"Refreshing tool detection…"`, then reports the outcome of the refresh on completion. Detection runs asynchronously; the picker overlays read from the cache on next open.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; calls `refreshDetection` through the command context.
- **See also**: `/crew`.

---

## Workflow

Commands that mutate the active run: rewind to an earlier phase, re-run a task, manage the queue, approvals, and the run's written changes. `category: 'workflow'` in the registry. Most are restricted to the `workflow` screen, and the rewind family additionally gates on the current `Phase`.

### `/revise-spec [comment]`

- **Purpose**: Rewind the workflow to the spec phase. With a comment, the next planner pass regenerates the supporting spec and Task Brief using the comment as feedback. Without a comment, the workflow jumps back to the spec approval gate so you can re-read it.
- **Screens**: `workflow`.
- **Phase guard**: `canReviseSpec` — allowed in `reviewing-spec`, `clarifying`, `constitution-check`, `planning`, `reviewing-plan`, `reviewing-briefs`, `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`. Denied in `idle`, `researching`, `specifying`, `complete`.
- **Args**: optional free-form comment. The remainder of the line after `/revise-spec ` is passed verbatim, trimmed.
- **Example**: `/revise-spec the validator should also strip whitespace`
- **Behavior**: If the guard fails, the feedback line reads `"No spec to revise in this phase"`. Otherwise `requestRewind('spec', comment)` is dispatched through `src/features/workflow/handlers.ts`, the lifecycle store transitions, and the orchestrator picks up the rewind on its next tick.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; context wiring at `src/app/command-context.ts`.
- **See also**: `/revise-plan`, `/redo-task`.

### `/revise-plan [comment]`

- **Purpose**: Rewind to the plan phase while preserving the spec. With a comment, the Task Brief and dependent plan artifacts are regenerated using the comment; without a comment, the workflow jumps to the plan approval gate.
- **Screens**: `workflow`.
- **Phase guard**: `canRevisePlan` — allowed from `reviewing-plan` onward (`reviewing-plan`, `reviewing-briefs`, `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`).
- **Args**: optional free-form comment, same parsing as `/revise-spec`.
- **Example**: `/revise-plan split task T003 into smaller steps`
- **Behavior**: If the guard fails the feedback line reads `"No plan to revise in this phase"`. Otherwise `requestRewind('plan', comment)` runs and the orchestrator regenerates downstream artifacts.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; context wiring at `src/app/command-context.ts`.
- **See also**: `/revise-spec`, `/redo-task`.

### `/redo-task <id>`

- **Purpose**: Reset a single task to `pending` and re-run it. Does not trigger replanning — the task loop picks the task up on its next iteration with a fresh implementer call.
- **Screens**: `workflow`.
- **Phase guard**: `canRedoTask` — `implementing`, `validating-task`, or `escalating` only; elsewhere the feedback line reads `"Tasks can only be redone while implementing"`.
- **Args**: required task ID, e.g. `T001`. Calling without an ID prints `"/redo-task requires a task ID. Usage: /redo-task T001"`.
- **Example**: `/redo-task T003`
- **Behavior**: On failure (no active workflow, missing ID, wrong phase) an error appears on the feedback line. On success the lifecycle store transitions and the existing implementer subprocess for that task is replaced on the next loop iteration.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; reset dispatched via `requestRewind({ target: 'task', taskId })` in `src/app/command-context.ts`.
- **See also**: `/revise-plan`.

### `/queue [show|clear]`

- **Purpose**: Inspect or clear the planner message queue. Messages typed during a planner call are queued and replayed on the next planner turn if they are still pending delivery; `/queue` lets you see how many are pending and discard pending-undelivered entries if you change your mind.
- **Screens**: `workflow`.
- **Args**: `show` (default when no argument is given) or `clear` (the `QUEUE_ACTIONS` tuple in `src/core/runtime/commands/types.ts`). Any other value prints `"Unknown queue command: <sub>. Use: /queue show or /queue clear"`.
- **Example**: `/queue`, `/queue show`, `/queue clear`.
- **Behavior**: `show` prints `"Queue is empty"` or `"Queue: N message(s) pending"`. `clear` prints `"Cleared N queued message(s)"` or `"Queue is already empty"`. Delivered native messages and already-drained history are not cleared.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; depth read from `lifecycleStore.get().queueDepth`; clearing routes through `requestClearQueue()` in `src/features/workflow/handlers.ts`.
- **See also**: `/handoff`.

### `/handoff <target> [task-id]`

- **Purpose**: Export a Handoff Pack for the active session — a self-contained directory of markdown files that an external agent (Claude Code, GitHub Copilot, spec-kit, AGENTS.md-style harness) can pick up and continue the work.
- **Screens**: `workflow`, `summary`.
- **Args**:
  - `<target>` (required): one of `spec-kit`, `agents-md`, `claude-code`, `copilot-issue` (the `HANDOFF_TARGETS` tuple in `src/core/handoff/targets.ts`). Invalid values print `"Unknown target \"<x>\". Valid: spec-kit, agents-md, claude-code, copilot-issue"`.
  - `[task-id]` (optional): a single task ID (e.g. `T003`) to export a single-task pack instead of the full session.
- **Parsing**: the argument string is split on whitespace; the first token is the target, the second (if any) is the task ID. Calling without a target prints `"Usage: /handoff <target> [task-id]"`.
- **Example**: `/handoff spec-kit`, `/handoff claude-code T003`, `/handoff copilot-issue`
- **Behavior**: Writes the pack to `.splitbrief/sessions/<sessionId>/handoffs/<target>/` in `overwrite` mode. On success prints `"Handoff written to: <outputDir>"`. On failure prints the error message. Requires an active session — fails with `"No active session for handoff"` otherwise.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; calls `writeHandoffPack` from `src/engine/handoff/write.ts` via the command context.
- **See also**: `/sessions`, `/export`.

### `/approval [list|clear]`

- **Purpose**: Inspect or revoke sticky approval grants — the persistent "always approve this file-write pattern" decisions you have made during prior runs (e.g. always allow writes under `src/foo/**`).
- **Screens**: `workflow`, `summary`.
- **Args**: optional. `list` (default) shows the current grants; `clear` revokes all grants (the `APPROVAL_ACTIONS` tuple in `src/core/runtime/commands/types.ts`).
- **Example**: `/approval`, `/approval list`, `/approval clear`
- **Behavior**:
  - `list` prints `"No sticky approvals on record."` if empty, otherwise `"Approvals: <pattern> (<class>, <scope>), …"`.
  - `clear` prints `"Cleared N approval grant(s)."`.
  - Anything else prints `"Unknown approval command: <sub>. Use: /approval list or /approval clear"`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; backed by `readApprovalsStore` / `writeApprovalsStore` / `clearGrantsByScope` from `src/core/approval/store.ts`.
- **See also**: `/yolo`, `/settings`.

### `/run accept|reject`

- **Purpose**: Accept or roll back what this run wrote. Accepting writes an accepted run snapshot so a later rejection refuses to roll back past it; rejecting restores the baseline.
- **Screens**: `workflow`, `summary`.
- **Args**: required. `accept` or `reject` (the `RUN_ACTIONS` tuple in `src/core/runtime/commands/types.ts`); `reject` additionally requires the literal `confirm`. Missing or unknown actions print `"Usage: /run <accept|reject>"`; `/run reject` without confirmation prints `"Usage: /run reject confirm"`.
- **Example**: `/run accept`, `/run reject confirm`
- **Behavior**: `accept` prints `"Run accepted at snapshot <id>"`. `reject confirm` is refused while work is active (`"Run rejection is unavailable while work is active."`), when there is no snapshot (`"No run snapshot to reject."`), and when the latest snapshot was already accepted. Otherwise files are restored only if their current hash still matches the latest SPLITBRIEF-written hash; user edits made after the snapshot are reported as conflicts and never overwritten, and restored/deleted counts are reported on success.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; snapshot behavior in `src/engine/snapshots/run/lifecycle.ts`; hash-guarded rollback in `src/engine/snapshots/run/rollback.ts`.
- **See also**: `splitbrief snapshot create`, `splitbrief snapshot restore`.

### `/yolo`

- **Purpose**: Toggle file-write tiered approvals off or back on for the current session.
- **Screens**: all.
- **Args**: none.
- **Example**: `/yolo`
- **Behavior**: Flips the approval-enabled state and prints either `YOLO mode ON — file-write tiered approvals disabled` or `YOLO mode OFF — file-write tiered approvals restored`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; approval state wiring in `src/app/command-context.ts`.
- **See also**: `/approval`, `/settings`.

---

## View

Commands that change what the workflow screen shows without touching the run. `category: 'view'` in the registry.

### `/scroll <top|bottom|page-up|page-down>`

- **Purpose**: Move the workflow conversation without relying on terminal-delivered navigation keys.
- **Screens**: `workflow`.
- **Args**: required. `top` jumps to the oldest visible conversation rows, `bottom` returns to live output, `page-up` moves up by one viewport page, and `page-down` moves down by one viewport page (the `SCROLL_COMMAND_TARGETS` tuple).
- **Example**: `/scroll top`, `/scroll bottom`, `/scroll page-up`, `/scroll page-down`.
- **Behavior**: Dispatches the same row-based scroll actions as the keyboard path. This is the guaranteed route when a terminal does not forward `Home`, `End`, `PageUp`, or `PageDown`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; command context reads the conversation scroll snapshot and writes `conversationScrollStore`.
- **See also**: `/activity`, `/sidebar`.

### `/activity`

- **Purpose**: Toggle the latest expandable runner-activity block in the workflow conversation.
- **Screens**: `workflow`.
- **Args**: none.
- **Shortcut**: `Ctrl+A` (`src/core/keybindings/registry.ts`); `/activity` is the guaranteed command path.
- **Example**: `/activity`
- **Behavior**: Expands the most recent compact activity block with hidden rows, or collapses it if it is already expanded. Collapsed activity blocks show a compact key affordance such as `ctrl+a` when earlier rows are hidden. If no activity block has hidden rows, the feedback line says so.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; command context uses `findLatestExpandableActivityBatchKey()` and `conversationScrollStore.toggleActivityBatch()`.
- **See also**: `/scroll`, `/diff`.

### `/sidebar`

- **Purpose**: Show or hide the workflow sidebar.
- **Screens**: `workflow`.
- **Args**: none.
- **Example**: `/sidebar`
- **Behavior**: Toggles the workflow sidebar and reports `"Sidebar shown"` or `"Sidebar hidden"` on the feedback line. On small terminals the command reports that the sidebar is hidden instead of claiming it was shown. There is no global shortcut so normal composer text-editing chords stay unclaimed.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; command context toggles `controlsStore.sidebarVisible`.
- **See also**: `/scroll`, `/activity`.

### `/diff`

- **Purpose**: Expand or collapse the latest diff block in the workflow conversation — the command mirror of `Ctrl+D`.
- **Screens**: `workflow`.
- **Args**: none.
- **Shortcut**: `Ctrl+D` (`src/core/keybindings/registry.ts`).
- **Example**: `/diff`
- **Behavior**: Prints `"Expanded latest diff"` or `"Collapsed latest diff"`. With no diff to show, the feedback line says why instead. Same phase semantics as the key.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; toggle wiring in the command context.
- **See also**: `/activity`, `/cost`.

### `/cost`

- **Purpose**: Open the cost breakdown — the command mirror of `Ctrl+G`.
- **Screens**: `workflow`.
- **Args**: none.
- **Shortcut**: `Ctrl+G` (`src/core/keybindings/registry.ts`).
- **Example**: `/cost`
- **Behavior**: Opens the `cost-drilldown` overlay, which breaks the run's spend down by seat and by phase. Same phase semantics as the key.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; opens overlay via `overlayStore.open`.
- **See also**: `/copy` (`/copy cost`), `/diff`.

---

## Input & output

Commands that move data in or out: clipboard copies, exports, transcript compaction, and image attachments. `category: 'io'` in the registry.

### `/copy [message|brief|path|command|cost]`

- **Purpose**: Copy a value you are reviewing to the system clipboard, so you do not have to select terminal text. Grabs the planner's last message, a Task Brief, a brief's file path, the planner command, or the cost summary.
- **Screens**: `workflow` only. Not available on `home` — copy targets read workflow review state.
- **Args**: optional target. One of `message`, `brief`, `path`, `command`, `cost` (the `COPY_TARGETS` tuple in `src/core/runtime/commands/types.ts`). Defaults to `message` when omitted. Any other value prints `"Invalid copy target: <x>. Valid: message, brief, path, command, cost"`.
  - `message` — the planner's most recent assistant text.
  - `brief` — the focused (or top-of-window) Task Brief's source text.
  - `path` — the focused brief's file path, relative to the project directory.
  - `command` — the configured planner runner command.
  - `cost` — the current cost summary text.
- **Example**: `/copy`, `/copy brief`, `/copy path`, `/copy cost`
- **Behavior**: Resolves the raw value (never the sanitized display copy) and writes it to the clipboard. When the target has no value the feedback line reads `"Nothing to copy"`. A confirmed native or tmux copy reads `"Copied (native)"` / `"Copied (tmux-buffer)"`; an OSC-52 escape the terminal may silently drop reads `"Copy escape sent; verify your clipboard (some terminals block it)"`; a failure reads `"Could not copy"`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; value resolution in `src/features/workflow/copy/resolve.ts`; clipboard delivery in `src/lib/clipboard/clipboard.ts`.
- **See also**: `/export`, `/handoff`.

### `/export`

- **Purpose**: Export the current session as a self-contained HTML report.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/export`
- **Behavior**: Writes `report.html` into the current session directory. On success the feedback line includes the report path; on failure it reports the export error.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; export pipeline in `src/engine/export/`.
- **See also**: `/handoff`, `/sessions`.

### `/compact-transcript`

- **Purpose**: Summarize older persisted planner/user turns into a compact transcript summary so future resume context can stay small.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/compact-transcript`
- **Behavior**: Uses the current planner from config. If that planner does not advertise `supportsSelfSummarisation`, the feedback line reports that transcript compaction is unsupported and no file is changed. Otherwise SPLITBRIEF calls `compactTranscript()` for the current session directory, appends a summary entry to `session.jsonl`, leaves recent messages verbatim, and reports how many older messages were summarized. `workflow.compactionFormat` controls whether the appended summary is freeform text or structured JSON; `auto` picks structured for `api` and `agent-sdk` planners and freeform for `cli`, `shell`, and `agent`. Structured validation failures are saved as freeform text. The log stays append-only; compaction does not delete historical lines.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; core compaction in `src/core/sessions/compaction.ts`.
- **See also**: `/sessions`, `/handoff`.

### `/image <path>|list|remove`

- **Purpose**: Attach, list, or remove images (PNG, JPG, etc.) for the next planner call. Useful for "here is a screenshot of the bug" workflows.
- **Screens**: `home`, `workflow`.
- **Guard**: the PLAN seat must be able to see images. On a seat without vision the command is blocked with `"PLAN seat cannot see images — pick a vision model with /crew plan"` instead of dropping the attachment silently at call time. CLI and Agent SDK seats can; an `api` seat depends on the model; `shell` and `agent` seats never can.
- **Args**: a file path, or one of `list` / `remove` (the `IMAGE_ACTIONS` tuple in `src/core/runtime/commands/types.ts`). No argument behaves like `list`; `remove` takes a 1-based index or the attachment's ID.
- **Example**: `/image ./screenshots/bug.png`, `/image list`, `/image remove 1`, `/image remove att_a8f3c2`
- **Behavior**:
  - `list` (or no argument) with nothing pending: `"No image attachments pending. Usage: /image <path>"`; otherwise `"Pending attachments: 1: <path>, 2: <path>"`.
  - A path on success: `"Attached: <resolved-path>"`; on failure `"Cannot attach: <reason>"` (file missing, unsupported format, etc.).
  - `remove` without a target: `"Usage: /image remove <index|id>"`. On success `"Removed: <input>"`, on no match `"No attachment matched: <input>"`.
- **Implementation**: catalog at `src/core/runtime/commands/registry.ts`; attachment helpers in `src/stores/workflow/attachments.ts`, backed by `src/core/attachments/resolve.ts`.
- **See also**: `/crew`.

---

## Aliases

Alias names resolve to their target in `findRuntimeCommand` (`src/core/runtime/commands/lookup.ts`) and carry their argument with them. They are kept for one release; use the target name.

| Alias | Resolves to | Note |
|---|---|---|
| `/config` | `/settings` | Long-standing alias. |
| `/planner` | `/crew plan` | Kept for one release. |
| `/implementer` | `/crew build` | Kept for one release. |
| `/reviewer` | `/crew review` | Kept for one release. |
| `/accept-run` | `/run accept` | Kept for one release. |
| `/reject-run` | `/run reject` | Kept for one release; still needs `confirm`. |
| `/attach` | `/image` | Kept for one release. |
| `/detach` | `/image remove` | Kept for one release. |

## Removed

These names no longer exist. Typing one prints `"<name> was removed: <pointer>"` instead of `Unknown command`, for one release (`REMOVED_COMMANDS` in `src/core/runtime/commands/types.ts`).

| Removed | Pointer |
|---|---|
| `/effort` | `effort lives on the seat: /crew plan` — reasoning effort is a per-seat field, edited in the Crew section; delivery per runner kind is documented in [`CONFIGURATION.md`](./CONFIGURATION.md). |
| `/repomap` | `the repo map rebuilds itself on each planning run, with no manual step` — background on the map in [`REPOMAP.md`](./REPOMAP.md). |
| `/resume` | `a paused workflow resumes from its approval prompt` — see [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) for `splitbrief resume`. |

---

## Keyboard shortcuts

Most slash commands have no dedicated keybinding — open the command palette with `Ctrl+K` and type. The keys below are bound directly in the input handlers (`src/app/keys.ts`, `src/features/workflow/hooks/use-keys.ts`) and run without going through the slash dispatcher.

### Global (any screen)

| Key | Action | Source |
|---|---|---|
| `Ctrl+K` | Open command palette | `src/app/keys.ts` |
| `Ctrl+/` | Open help overlay (sent as control character `\x1f`) | `src/app/keys.ts` |
| `Ctrl+,` | Open settings overlay | `src/app/keys.ts` |
| `Ctrl+Q` | Quit application | `src/app/keys.ts` |
| `Ctrl+C` | Interrupt in-flight turn (workflow screen) or exit otherwise | `src/app/keys.ts` |
| `Ctrl+C` ×2 | Exit (second press while exit is armed, within 2s) | `src/app/keys.ts` |
| `Esc Esc` | Hard-interrupt the running step (workflow enters the interrupted state); again while interrupted or at a prompt, cancel the workflow (workflow screen) | `src/app/keys.ts` |
| `Esc` | Close the topmost overlay, or navigate home once the workflow is cancelled | `src/app/keys.ts` |

`Ctrl+C` behaviour depends on the screen. Off the workflow screen (and for an attach client), it exits immediately. On the workflow screen, the first press fires the same hard interrupt as `Esc Esc` (`interruptTurn` in `src/features/workflow/handlers.ts` — the workflow is marked interrupted and an in-flight runner's process group is terminated) only when the Esc ladder would arm an interrupt: a live phase is running (`isLivePhase` from `src/core/phases.ts`), the workflow is not already cancelled or interrupted, and no question prompt owns the composer. While a question prompt (including the interrupted continuation prompt) is open, or the workflow is already interrupted, there is no turn to interrupt, so the press interrupts nothing. Either way the press then arms the abort store for exit via `abortStore.arm('exit')` (`src/stores/workflow/abort.ts`), which shows `"Ctrl+C again to exit"`. A second press while `armed` is `'exit'` (within the 2s auto-clear window) exits.

`Esc Esc` is a double-press ladder on the workflow screen. The first press arms an intent — `interrupt` while a live phase runs, or `cancel` while a question prompt is open or the workflow is already interrupted (`abortStore.arm(...)`); the second press fires it. Firing `interrupt` is a hard stop: the in-flight call aborts, the runner's process group is terminated (graceful signal first, force-kill after a grace window), and the workflow enters a visible interrupted state with the composer active — the byline reads the interim `interrupted — finishing current step…` until the continuation prompt parks at the next call boundary (immediately, for a live in-flight call), then `interrupted — Enter retry · type to steer`; once parked, submitting typed text steers the resumed workflow, submitting an empty message (plain Enter) retries the interrupted call. `Esc Esc` is ignored — it arms nothing and no byline changes — during the `validating-task`, `analyzing`, and `constitution-check` phases (per-task validation, the per-task git commit, speckit's analyze step, and speckit's constitution-check gate), since none of these is in the live-phase set (`isLivePhase` from `src/core/phases.ts`); the interim `finishing current step…` byline above already covers the one dead zone that is inside a live phase, the gap between runner calls, where the press still arms and parks at the next call boundary. A second `Esc Esc` while interrupted cancels the entire workflow. The abort store tracks one `armed` kind at a time (`none`, `exit`, `interrupt`, or `cancel`) and auto-clears after 2 seconds.

### Home screen only

| Key | Action | Source |
|---|---|---|
| `Ctrl+S` | Open the skills overlay | `src/app/keys.ts` |
| `Ctrl+R` | Focus the recent sessions list | `src/features/home/use-recent-sessions-focus.ts` |

### Workflow screen

These keys are handled in `src/features/workflow/hooks/use-keys.ts` and routed through pure functions in `src/features/workflow/keyboard.ts`. Conversation keys take effect only when no overlay is open and the input mode is `normal`.

macOS terminals do not always forward physical `PageUp`, `PageDown`, `Home`, or `End` without an `Fn` layer. In normal workflow input, the composer owns text-editing chords such as `Ctrl+B`, `Ctrl+E`, and `Ctrl+F`, so `/scroll` is the reliable command path for conversation paging.

| Key | Action | Source |
|---|---|---|
| `Ctrl+G` | Open the cost drilldown overlay (any key dismisses it) | `use-keys.ts:118` |
| `Ctrl+D` | Toggle the most recent diff in the conversation; in an attached client, detach instead | `keyboard.ts` `handleWorkflowCtrlChords` |
| `Esc` | Navigate home (only when the workflow has been cancelled) | `src/app/keys.ts` |
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

When the review pane has a `filePath` set (e.g. inspecting a spec or plan), these keys scroll the review content instead of the conversation. They are handled before the conversation-scroll path:

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

### Brief review editing

During simple Task Brief review, typed commands use `src/features/workflow/review-parser.ts`. Row focus and `y` yank are handled by `src/features/workflow/hooks/use-brief-review-keys.ts` (mounted from `WorkflowScreen`):

| Key | Action | Source |
|---|---|---|
| `↑` / `↓` | Select a Task Brief row (review mode only) | `use-brief-review-keys.ts` |
| `y` | Copy the focused brief (`/copy brief` parity) | `use-brief-review-keys.ts` |

One-key gate actions, armed only while the composer draft is empty and no brief row is focused:

| Key | Action | Owner |
|---|---|---|
| `y` | Approve | `core/keybindings/review.ts` |
| `e` | Open the review file in the external editor | `core/keybindings/review.ts` |
| `c` | Start a comment (seeds the draft with `comment `) | `core/keybindings/review.ts` |
| `q` | Reject | `core/keybindings/review.ts` |

Typed commands (unchanged; these are what RPC and attached clients send):

| Command | Action |
|---|---|
| `approve` / `y` | Approve briefs |
| `Ctrl+E` / `e` / `edit` | Open persisted `tasks.md` in the external editor. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. |
| `E` / `edit-file` | Open persisted `tasks.md` in the external editor. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. |
| `comment <text>` | Send revise feedback |
| `reject` / `q` / `quit` | Reject briefs |

`workflow.briefReview: rich` is deprecated and maps to the same simple review commands; it no longer opens an inline Task Brief plan editor.

### Inline editor (spec, plan, and Task Brief)

`Ctrl+E` during a review phase opens the built-in inline editor instead of shelling out: in `reviewing-spec` / `reviewing-plan` it opens a full-surface exclusive overlay over `spec.md` / `plan.md`; in `reviewing-briefs` it opens the small-viewport field editor over the focused Task Brief. The editor is protocol-free and single-owner — while it is open it owns keyboard input and no other handler competes. `$EDITOR` (see the `edit-file` command above) remains available as the opt-in secondary path for bulk or structural edits.

The keymap is protocol-free and is the single source of truth in [`src/core/keybindings/editor.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/keybindings/editor.ts) (`resolveEditorKeyAction`); the chords below are asserted against that resolver by [`src/core/keybindings/editor.test.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/core/keybindings/editor.test.ts) so this table cannot drift.

| Key | Action |
|---|---|
| `Enter` / `Ctrl+J` | Insert a newline (Enter never commits) |
| `Ctrl+S` | Save |
| `Esc` | Cancel (discard, close the editor) |
| `Ctrl+O` | Open the current file in the external editor (raw surface pre-saves the buffer, CAS-guarded; Task Brief field surface discards the in-progress edit and opens `tasks.md`) |
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

`Shift` combined with any motion (`←/→`, word, `Home`/`End`, `Ctrl+Home`/`Ctrl+End`, `PageUp`/`PageDown`) extends the selection; the same motion without `Shift` collapses it. `Ctrl+C` is **never** mapped to copy, cut, or select-all — it keeps its interrupt / exit semantics (copy is `Alt+C` or `Ctrl+Y`), so the editor cannot swallow the interrupt chord. `Home`, `End`, `PageUp`, and `PageDown` are recaptured as editor motions while the exclusive overlay is open rather than being surrendered to the conversation transcript.

When the opt-in `$EDITOR` handover is used instead, `VISUAL` takes precedence over `EDITOR` in editor resolution ([`src/features/workflow/editor-command.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/features/workflow/editor-command.ts) `resolveEditorArgv`); this precedence is asserted by [`src/features/workflow/editor-command.test.ts`](https://github.com/b4r7x/splitbrief/blob/main/src/features/workflow/editor-command.test.ts).

### Summary screen

| Key | Action | Source |
|---|---|---|
| `Enter` | Continue (handled by the summary screen; shortcut labels come from `src/core/keybindings/registry.ts`) |

---

## Cross-reference: shortcuts declared in the keybinding registry

The `SHORTCUTS` table in `src/core/keybindings/registry.ts` is the single source of truth for the labels rendered next to slash commands in the help overlay and command palette. Some entries are advisory (the actual handler is elsewhere), but the registry is what the UI reads:

| ID | Key | Description | Screens |
|---|---|---|---|
| `exit` | `Ctrl+C` | Interrupt, then exit (press again) | workflow |
| `exit` | `Ctrl+C` | Exit | home, summary, setup |
| `command-palette` | `Ctrl+K` | Command palette | all |
| `help` | `Ctrl+/` | Help | all |
| `quit` | `Ctrl+Q` | Quit | all |
| `interrupt` | `Esc Esc` | Interrupt current step (press again) | workflow |
| `cancel` | `Esc Esc` | Cancel workflow at a prompt (press again) | workflow |
| `recent-sessions` | `Ctrl+R` | Focus recent sessions | home |
| `skills` | `Ctrl+S` | Skills picker | home |
| `settings` | `Ctrl+,` | Settings | all |
| `close-overlay` | `Esc` | Close overlay | all |
| `toggle-diff` | `Ctrl+D` | Toggle diff; attached detaches | workflow |
| `cost-drilldown` | `Ctrl+G` | Cost drilldown | workflow |
| `scroll` | `Shift+↑/↓, PgUp/PgDn, Home/End` | Scroll; PageUp/PageDown; /scroll top\|bottom | workflow |
| `review-edit` | `Ctrl+E` | Open editor in review mode only | workflow |
| `activity` | `/activity, Ctrl+A` | Expand activity rows; compact rows show `ctrl+a` | workflow |
| `continue` | `Enter` | Continue | summary |

---

## Index by command name

Alphabetical, for fast lookup. Aliases and removed names are listed under [Aliases](#aliases) and [Removed](#removed).

- [`/activity`](#activity) — expand or collapse the latest hidden activity rows.
- [`/approval`](#approval-listclear) — list or clear sticky approval grants.
- [`/compact-transcript`](#compact-transcript) — summarize older persisted transcript turns.
- [`/copy`](#copy-messagebriefpathcommandcost) — copy a reviewed value to the system clipboard.
- [`/cost`](#cost) — open the cost breakdown.
- [`/crew`](#crew-planbuildreview) — change who fills the `PLAN`, `BUILD`, or `REVIEW` seat.
- [`/diff`](#diff) — expand or collapse the latest diff.
- [`/export`](#export) — export the session as an HTML report.
- [`/handoff`](#handoff-target-task-id) — export a Handoff Pack.
- [`/help`](#help) — open the help overlay.
- [`/home`](#home) — navigate to the home screen.
- [`/image`](#image-pathlistremove) — attach, list, or remove images for the next planner call.
- [`/mode`](#mode-name) — switch workflow mode.
- [`/palette`](#palette) — open the command palette.
- [`/queue`](#queue-showclear) — inspect or clear the planner message queue.
- [`/quit`](#quit) — exit the application.
- [`/redo-task`](#redo-task-id) — reset and re-run a single task.
- [`/refresh`](#refresh) — re-run tool detection.
- [`/revise-plan`](#revise-plan-comment) — rewind to the plan phase.
- [`/revise-spec`](#revise-spec-comment) — rewind to the spec phase.
- [`/run`](#run-acceptreject) — accept or roll back what this run wrote.
- [`/scroll`](#scroll-topbottompage-uppage-down) — move the workflow conversation by command.
- [`/sessions`](#sessions) — browse past sessions.
- [`/settings`](#settings-alias-config) — open the settings overlay (Crew first).
- [`/sidebar`](#sidebar) — show or hide the workflow sidebar.
- [`/skills`](#skills) — pick planner skills (home only).
- [`/yolo`](#yolo) — toggle file-write tiered approvals for the session.

---

## See also

- [`FEATURES.md`](./FEATURES.md#slash-commands-palette) — the shorter overview document, useful as a quick refresher.
- [`docs/WORKFLOW.md`](./WORKFLOW.md) — workflow phases, modes, and the rewind state machine.
- [`docs/CONCEPTS.md`](./CONCEPTS.md) — shared vocabulary (phase, queue, awaiting-continue, etc.).
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the TUI, stores, engine, and runners are layered.
- [`docs/STORES.md`](./STORES.md) — `configStore`, `overlayStore`, `feedbackStore`, `lifecycleStore`, `routerStore`, `attachmentsStore`.
- [`src/core/runtime/commands/`](https://github.com/b4r7x/splitbrief/tree/main/src/core/runtime/commands) — `dispatch.test.ts`, `lookup.test.ts`, and split `registry-*.test.ts` suites (`registry-configuration.test.ts`, `registry-recovery.test.ts`, `registry-conversation.test.ts`, `registry-session.test.ts`, `registry-snapshots.test.ts`, …) cover the phase / screen / arg matrix.
