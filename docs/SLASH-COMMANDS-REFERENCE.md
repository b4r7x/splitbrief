# Slash Commands Reference

The complete reference for every slash command available in the diptych TUI. This document is the exhaustive lookup — every entry in [`src/core/slash-commands/catalog.ts`](../src/core/slash-commands/catalog.ts) is documented here, grouped by purpose, with usage, screen availability, behaviour, and cross-references.

If you only want a short overview, see [`docs/SLASH-COMMANDS.md`](./SLASH-COMMANDS.md). If you are adding a new command, follow the contract in [`src/core/slash-commands/types.ts`](../src/core/slash-commands/types.ts) and the dispatch rules in [`src/core/slash-commands/dispatch.ts`](../src/core/slash-commands/dispatch.ts).

## How dispatch works

Type `/` in the TUI to open the command picker. Names resolve in two phases inside `src/core/slash-commands/dispatch.ts`:

1. Exact match on `name` or any `aliases`. Example: `/config` resolves to `/settings`.
2. Fuzzy match via the `fzf` matcher in `src/core/slash-commands/fuzzy.ts`. Example: `/rev-spec` resolves to `/revise-spec`.

Each command declares `validScreens`. The four screens are `home`, `workflow`, `summary`, and `setup` (`src/stores/navigation/router.ts:6`). Invoking a command on the wrong screen surfaces an error through the `feedbackStore`. The constant `ALL_SCREENS` (`src/stores/navigation/router.ts:8`) is shorthand for "available everywhere".

Three rewind-family commands also enforce a `phaseGuard`. The guards are the single source of truth for when a rewind can run:

- `canReviseSpec(phase)` — `src/core/slash-commands/catalog.ts:17` — true once the spec is written (`reviewing-spec` and later, except `idle`/`complete`).
- `canRevisePlan(phase)` — `src/core/slash-commands/catalog.ts:21` — true once the plan is written (`reviewing-plan`, `reviewing-briefs`, and later).
- `canRedoTask(phase)` — `src/core/slash-commands/catalog.ts:25` — true only during `implementing`, `validating-task`, or `escalating`.

Handlers reach the engine and stores through the `CommandContext` interface (`src/core/slash-commands/types.ts:21`), wired up for the TUI in `src/app/slash-command-context.ts`. The catalog itself never imports stores directly; this keeps the command list testable in isolation (see `src/core/slash-commands/catalog.test.ts`).

There are 25 slash commands in total. They cover overlays, workflow mode/tool selection, rewind/redo, queue and artifact actions, transcript compaction, attachments, approvals, run accept/reject, and quitting. They are grouped below by purpose.

---

## Workflow control

Commands that mutate the active workflow: rewind to an earlier phase, re-run a task, or drain the message queue. All are restricted to the `workflow` screen, and the rewind family additionally gates on the current `Phase`.

### `/revise-spec [comment]`

- **Purpose**: Rewind the workflow to the spec phase. With a comment, the next planner pass regenerates the supporting spec and Task Brief using the comment as feedback. Without a comment, the workflow jumps back to the spec approval gate so you can re-read it.
- **Screens**: `workflow`.
- **Phase guard**: `canReviseSpec` — allowed in `reviewing-spec`, `clarifying`, `constitution-check`, `planning`, `reviewing-plan`, `reviewing-briefs`, `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`. Denied in `idle`, `researching`, `specifying`, `complete`.
- **Args**: optional free-form comment. The remainder of the line after `/revise-spec ` is passed verbatim, trimmed.
- **Example**: `/revise-spec the validator should also strip whitespace`
- **Behavior**: If the phase guard fails, the feedback line shows `"/revise-spec is only available after the spec is written."`. Otherwise `requestRewind('spec', comment)` is dispatched through `src/features/workflow/handlers.ts`, the lifecycle store transitions, and the orchestrator picks up the rewind on its next tick.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:156`; context wiring at `src/core/slash-commands/context.ts:47`.
- **See also**: `/revise-plan`, `/redo-task`.

### `/revise-plan [comment]`

- **Purpose**: Rewind to the plan phase while preserving the spec. With a comment, the Task Brief and dependent plan artifacts are regenerated using the comment; without a comment, the workflow jumps to the plan approval gate.
- **Screens**: `workflow`.
- **Phase guard**: `canRevisePlan` — allowed from `reviewing-plan` onward (`reviewing-plan`, `reviewing-briefs`, `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`).
- **Args**: optional free-form comment, same parsing as `/revise-spec`.
- **Example**: `/revise-plan split task T003 into smaller steps`
- **Behavior**: If the phase guard fails the feedback line shows `"/revise-plan is only available after the plan is written."`. Otherwise `requestRewind('plan', comment)` runs and the orchestrator regenerates downstream artifacts.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:175`; context wiring at `src/core/slash-commands/context.ts:47`.
- **See also**: `/revise-spec`, `/redo-task`.

### `/redo-task <id>`

- **Purpose**: Reset a single task to `pending` and re-run it. Does not trigger replanning — the task loop picks the task up on its next iteration with a fresh implementer call.
- **Screens**: `workflow`.
- **Phase guard**: `canRedoTask` — `implementing`, `validating-task`, or `escalating` only.
- **Args**: required task ID, e.g. `T001`. Calling without an ID prints `"/redo-task requires a task ID. Usage: /redo-task T001"`.
- **Example**: `/redo-task T003`
- **Behavior**: On failure (no active workflow, missing ID, wrong phase) an error appears on the status line. On success the lifecycle store transitions and the existing implementer subprocess for that task is replaced on the next loop iteration.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:194`; reset dispatched via `requestRewind({ target: 'task', taskId })` in `src/core/slash-commands/context.ts:51`.
- **See also**: `/revise-plan`.

### `/queue [show|clear]`

- **Purpose**: Inspect or drain the planner message queue. Messages typed during a planner call are queued and replayed on the next planner turn; `/queue` lets you see how many are pending and discard them if you change your mind.
- **Screens**: `workflow`.
- **Args**: `show` (default when no argument is given) or `clear`. Any other value prints `"Unknown queue command: <sub>. Use: /queue show or /queue clear"`.
- **Example**: `/queue`, `/queue show`, `/queue clear`.
- **Behavior**: `show` prints `"Queue is empty"` or `"Queue: N message(s) pending"`. `clear` prints `"Cleared N queued message(s)"` or `"Queue is already empty"`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:217`; depth read from `lifecycleStore.get().queueDepth` in `src/core/slash-commands/context.ts:53`; clearing routes through `requestClearQueue()` in `src/features/workflow/handlers.ts`.
- **See also**: `/handoff`.

### `/accept-run`

- **Purpose**: Accept the current run state. This writes an accepted run snapshot so a later `/reject-run confirm` refuses to roll back past the accepted state.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/accept-run`
- **Behavior**: On success the feedback line includes the accepted snapshot ID. If there is no active session, the command reports `"No active session for /accept-run"`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts`; context wiring at `src/core/slash-commands/context.ts`; snapshot behavior in `src/engine/snapshots/run.ts`.
- **See also**: `/reject-run confirm`, `diptych snapshot create`.

### `/reject-run confirm`

- **Purpose**: Reject the latest run snapshot. Files are restored to the baseline only if their current hash still matches the latest diptych-written hash; user edits after that snapshot are preserved as conflicts.
- **Screens**: `workflow`, `summary`.
- **Args**: required literal `confirm`. Calling `/reject-run` without it prints `"Usage: /reject-run confirm"`.
- **Example**: `/reject-run confirm`
- **Behavior**: Restored and deleted counts are reported on success. Conflicts or missing snapshot files surface as feedback errors and are never overwritten. If the latest run snapshot was accepted, rejection is refused.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts`; context wiring at `src/core/slash-commands/context.ts`; hash-guarded rollback in `src/engine/snapshots/run.ts`.
- **See also**: `/accept-run`, `diptych snapshot restore`.

---

## Mode and effort

Configuration mutators that persist immediately to the project config (`.diptych/config.yaml`). Unlike opening a picker, these commands take effect on save and surface a confirmation message on the status line.

### `/mode [name]`

- **Purpose**: Switch workflow mode at runtime. With no argument, opens the mode-selector overlay so you can pick interactively. With a valid mode name, persists the selection via `configStore.save(...)` so subsequent runs inherit it.
- **Screens**: all (`home`, `workflow`, `summary`, `setup`).
- **Args**: optional. Valid values: `instant`, `quick`, `standard`, `speckit` (the `WORKFLOW_MODES` tuple in `src/core/schemas/enums.ts:67`). The legacy alias `full` is still parsed by the config schema but is not advertised here. Invalid values print `"Invalid mode: <x>. Valid modes: instant, quick, standard, speckit"`.
- **Example**: `/mode`, `/mode speckit`, `/mode instant`
- **Behavior**: Successful save prints `"Workflow mode set to: <mode>"`. Failure to save (typically a malformed config file) prints `"Failed to save config: <error>"` from `setFeedbackError`. Mode semantics live in `docs/WORKFLOW.md` §1.2.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:77`; persistence in `src/core/slash-commands/context.ts:21`.
- **See also**: `/settings`, `/effort`.

### `/effort <low|medium|high|xhigh>`

- **Purpose**: Set the planner reasoning effort. This propagates to the planner runner config (Claude Code, Codex, OpenAI-compatible API endpoints with reasoning parameters, etc.) and is persisted to project config.
- **Screens**: all.
- **Args**: required. Valid values: `low`, `medium`, `high`, `xhigh` (the `EFFORT_LEVELS` tuple in `src/core/schemas/enums.ts:115`). Calling without an argument prints `"Usage: /effort <low|medium|high|xhigh>"`.
- **Example**: `/effort high`, `/effort xhigh`
- **Behavior**: On success prints `"Planner effort set to: <value>"`. Invalid values print `"Invalid effort: <x>. Valid: low, medium, high, xhigh"`. Save failures surface the underlying error.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:98`; persistence in `src/core/slash-commands/context.ts:30`.
- **See also**: `/mode`, `/planner`.

### `/refresh`

- **Purpose**: Re-run tool detection — probes the system for installed CLIs (claude-code, codex, opencode, aider, copilot, kilo-code), reachable API endpoints (Ollama, LM Studio, OpenRouter, etc.), and refreshes the availability cache so newly installed tools become selectable in the planner and implementer pickers.
- **Screens**: all.
- **Args**: none.
- **Example**: `/refresh`
- **Behavior**: Immediately prints `"Refreshing tool detection..."`. On completion, prints `"Tool detection refreshed"` or `"Tool detection failed"`. Detection runs asynchronously; the picker overlays read from the cache on next open.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:143`; calls `refreshDetection(projectDir)` from `src/engine/detection/service.ts` via the wiring in `src/core/slash-commands/context.ts:42`.
- **See also**: `/planner`, `/implementer`.

---

## Pickers

Commands that open an overlay for interactive selection. None of these mutate state directly — they hand control to the overlay, which writes back through its own actions.

### `/sessions`

- **Purpose**: Browse past sessions. Opens the sessions overlay backed by `.diptych/sessions/` so you can resume, replay, or inspect a previous run.
- **Screens**: all.
- **Args**: none.
- **Example**: `/sessions`
- **Behavior**: Opens the `sessions` overlay. Selecting a session resumes it via the same path as `npm run dev -- resume <id>`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:59`; opens overlay via `overlayStore.open` (`src/core/slash-commands/context.ts:18`).
- **See also**: `/handoff`, `/home`.

### `/planner`

- **Purpose**: Open the planner picker to choose or reconfigure the planner runner (Claude Code CLI, an OpenAI-compatible endpoint, the Anthropic Agent SDK, etc.).
- **Screens**: all.
- **Args**: none.
- **Example**: `/planner`
- **Behavior**: Opens the `planner-picker` overlay. Selection updates the project config and triggers re-detection if needed.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:119`; opens overlay via `overlayStore.open`.
- **See also**: `/implementer`, `/effort`, `/refresh`, `/settings`.

### `/implementer`

- **Purpose**: Open the implementer picker to choose or reconfigure the implementer runner.
- **Screens**: all.
- **Args**: none.
- **Example**: `/implementer`
- **Behavior**: Opens the `implementer-picker` overlay. Same selection mechanics as the planner picker.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:127`; opens overlay via `overlayStore.open`.
- **See also**: `/planner`, `/refresh`, `/settings`.

### `/skills`

- **Purpose**: Pick planner skills for the upcoming session. Skills are pre-canned planner persona / instruction bundles that bias the planner toward specific kinds of work (testing, refactoring, security review, etc.).
- **Screens**: `home` only — skills can only be selected before a workflow starts.
- **Args**: none.
- **Shortcut**: `Ctrl+S` (home screen only — see `src/core/slash-commands/keybindings.ts:16`).
- **Example**: `/skills`
- **Behavior**: Opens the `skills` overlay. Selection persists to the project config so subsequent `start` commands inherit the skill set.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:50`; opens overlay via `overlayStore.open`.
- **See also**: `/settings`, `/planner`.

### `/settings` (alias `/config`)

- **Purpose**: Open the settings overlay (planner, model, workflow defaults, hooks, OTel). The catch-all configuration UI.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+,` (`src/core/slash-commands/keybindings.ts:18`).
- **Aliases**: `/config`.
- **Example**: `/settings`, `/config`
- **Behavior**: Opens the `settings` overlay. Mutations are persisted to project config on save.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:67`; opens overlay via `overlayStore.open`.
- **See also**: `/planner`, `/implementer`, `/skills`, `/mode`, `/effort`.

### `/palette`

- **Purpose**: Open the command palette — a searchable, keyboard-driven list of every palette-eligible slash command. Useful when you don't remember the exact command name.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+K` (`src/core/slash-commands/keybindings.ts:13`).
- **Example**: `/palette`
- **Behavior**: Opens the `command-palette` overlay. Items are derived from the catalog via `toPaletteItems` — commands without a `label` field are excluded but remain callable as `/name`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:42`; opens overlay via `overlayStore.open`.
- **See also**: `/help`.

---

## Output and artifacts

Commands that produce or manage on-disk artifacts: handoff packs for external agents, transcript compaction, the repo-map cache, and pending image attachments.

### `/handoff <target> [task-id]`

- **Purpose**: Export a Handoff Pack for the active session — a self-contained directory of markdown files that an external agent (Claude Code, GitHub Copilot, spec-kit, AGENTS.md-style harness) can pick up and continue the work.
- **Screens**: `workflow`, `summary`.
- **Args**:
  - `<target>` (required): one of `spec-kit`, `agents-md`, `claude-code`, `copilot-issue` (the `HANDOFF_TARGETS` tuple in `src/engine/handoff/types.ts:6`). Invalid values print `"Unknown target \"<x>\". Valid: spec-kit, agents-md, claude-code, copilot-issue"`.
  - `[task-id]` (optional): a single task ID (e.g. `T003`) to export a single-task pack instead of the full session.
- **Parsing**: the argument string is split on whitespace; the first token is the target, the second (if any) is the task ID. Calling without a target prints `"Usage: /handoff <target> [task-id]"`.
- **Example**: `/handoff spec-kit`, `/handoff claude-code T003`, `/handoff copilot-issue`
- **Behavior**: Writes the pack to `.diptych/sessions/<sessionId>/handoffs/<target>/` in `overwrite` mode. On success prints `"Handoff written to: <outputDir>"`. On failure prints the error message. Requires an active session — fails with `"No active session for handoff"` otherwise.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:246`; calls `writeHandoffPack` from `src/engine/handoff/write.ts` via the wiring in `src/core/slash-commands/context.ts:77`.
- **See also**: `/sessions`.

### `/compact-transcript`

- **Purpose**: Summarize older persisted planner/user turns into a compact transcript summary so future resume context can stay small.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/compact-transcript`
- **Behavior**: Uses the current planner from config. If that planner does not advertise `supportsSelfSummarisation`, the feedback line reports that transcript compaction is unsupported and no file is changed. Otherwise diptych calls `compactTranscript()` for the current session directory, appends a summary entry to `session.jsonl`, leaves recent messages verbatim, and reports how many older messages were summarized. `workflow.compactionFormat` controls whether the appended summary is freeform text or structured JSON; `auto` picks structured for `api` and `agent-sdk` planners and freeform for `cli`, `shell`, and `agent`. Structured validation failures are saved as freeform text. The log stays append-only; compaction does not delete historical lines.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts`; context wiring at `src/app/slash-command-context.ts`; core compaction in `src/core/sessions/compaction.ts`.
- **See also**: `/sessions`, `/handoff`.

### `/queue [show|clear]`

See [Workflow control](#workflow-control) above. Listed under workflow control because it mutates the planner message queue, but conceptually also a queued-output management command.

### `/repomap rebuild`

- **Purpose**: Clear the repo-map cache so the next planner phase re-parses the codebase from scratch. Useful when the repo has changed substantially since the cached map was built and stale entries are misleading the planner.
- **Screens**: all.
- **Args**: required. The only accepted sub-command is `rebuild`. Anything else (or no sub-command) prints `"Unknown repomap command: <sub>. Use: /repomap rebuild"`.
- **Example**: `/repomap rebuild`
- **Behavior**: On success prints `"Repomap cache cleared. Next planner phase will parse from scratch."` if the cache existed, or `"Repomap cache was not present."` otherwise. On failure prints `"Failed to clear repomap cache."`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:270`; cache clearing in `src/engine/codebase/rebuild.ts` via the wiring in `src/core/slash-commands/context.ts:55`. Repo-map tuning details in `docs/REPOMAP.md`.
- **See also**: `/refresh`.

### `/attach [path]`

- **Purpose**: Attach an image (PNG, JPG, etc.) for the next planner call. Useful for "here is a screenshot of the bug" workflows when the planner runner supports vision.
- **Screens**: `home`, `workflow`.
- **Args**: optional. With a path, attaches the file. Without arguments, lists currently pending attachments.
- **Example**: `/attach`, `/attach ./screenshots/bug.png`, `/attach /tmp/diagram.jpg`
- **Behavior**:
  - With no args and no pending attachments: `"No image attachments pending. Usage: /attach <path>"`.
  - With no args and pending attachments: `"Pending attachments: 1: <path>, 2: <path>"`.
  - With a path on success: `"Attached: <resolved-path>"`.
  - With a path on failure: `"Cannot attach: <reason>"` (file missing, unsupported format, etc.).
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:293`; attachment store at `src/stores/workflow/attachments.ts`; resolution via `requestAttach` in `src/features/workflow/handlers.ts`; wired in `src/core/slash-commands/context.ts:59`.
- **See also**: `/detach`.

### `/detach <index|id>`

- **Purpose**: Remove a pending image attachment by 1-based index or by the attachment's internal ID.
- **Screens**: `home`, `workflow`.
- **Args**: required. Either a 1-based index (matching the order shown by `/attach`) or the attachment's ID. Calling without an argument prints `"Usage: /detach <index|id>"`.
- **Example**: `/detach 1`, `/detach att_a8f3c2`
- **Behavior**: Numeric values within the pending range are treated as indices; otherwise the value is matched against attachment IDs via `requestDetach`. On success prints `"Detached: <input>"`. On no match prints `"No attachment matched: <input>"`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:319`; index lookup and detach wiring in `src/core/slash-commands/context.ts:65`.
- **See also**: `/attach`.

### `/approval [list|clear]`

- **Purpose**: Inspect or revoke sticky approval grants — the persistent "always approve this pattern" decisions you have made during prior runs (e.g. always allow `git status`, always allow writes under `src/foo/**`).
- **Screens**: `workflow`, `summary`.
- **Args**: optional. `list` (default) shows the current grants; `clear` revokes all grants.
- **Example**: `/approval`, `/approval list`, `/approval clear`
- **Behavior**:
  - `list` prints `"No sticky approvals on record."` if empty, otherwise `"Approvals: <pattern> (<class>, <scope>), …"`.
  - `clear` prints `"Cleared N approval grant(s)."`.
  - Anything else prints `"Unknown approval command: <sub>. Use: /approval list or /approval clear"`.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:338`; backed by `readApprovalsStore` / `writeApprovalsStore` / `clearGrantsByScope` from `src/engine/orchestrator/approvals-store.ts` via the wiring in `src/core/slash-commands/context.ts:93`.
- **See also**: `/settings`.

---

## Navigation

Commands that change which screen is active.

### `/home`

- **Purpose**: Navigate back to the home screen from an active workflow or summary screen. Does not abort or pause an in-flight workflow — the workflow continues in the background and you can return to it via `/sessions`.
- **Screens**: `workflow`, `summary`.
- **Args**: none.
- **Example**: `/home`
- **Behavior**: Calls `routerStore.navigate({ to: 'home' })`. The home screen shows the prompt input and recent sessions.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:135`; navigation wiring at `src/core/slash-commands/context.ts:19`.
- **See also**: `/sessions`, `/quit`.

---

## Help and diagnostics

### `/help`

- **Purpose**: Open the help overlay — a list of key bindings and the most-used slash commands.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+/` (`src/core/slash-commands/keybindings.ts:14`).
- **Example**: `/help`
- **Behavior**: Opens the `help` overlay. Press `Esc` to close.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:33`; opens overlay via `overlayStore.open`.
- **See also**: `/palette`.

---

## Lifecycle

### `/quit`

- **Purpose**: Exit the application immediately. The TUI tears down, any in-flight subprocesses are killed via the process registry.
- **Screens**: all.
- **Args**: none.
- **Shortcut**: `Ctrl+Q` (`src/core/slash-commands/keybindings.ts:15`). Also `Ctrl+C` twice within 2 seconds.
- **Example**: `/quit`
- **Behavior**: Calls the `exit` callback wired in `src/core/slash-commands/context.ts:20`. No confirmation prompt — use `/home` if you only want to leave the workflow screen.
- **Implementation**: catalog at `src/core/slash-commands/catalog.ts:364`.
- **See also**: `/home`.

---

## Keyboard shortcuts

Most slash commands have no dedicated keybinding — open the command palette with `Ctrl+K` and type. The keys below are bound directly in the input handlers (`src/hooks/use-app-keys.ts`, `src/features/workflow/hooks/use-workflow-keys.ts`) and run without going through the slash dispatcher.

### Global (any screen)

| Key | Action | Source |
|---|---|---|
| `Ctrl+K` | Open command palette | `src/hooks/use-app-keys.ts:82` |
| `Ctrl+/` | Open help overlay (sent as control character `\x1f`) | `src/hooks/use-app-keys.ts:85` |
| `Ctrl+,` | Open settings overlay | `src/hooks/use-app-keys.ts:86` |
| `Ctrl+Q` | Quit application | `src/hooks/use-app-keys.ts:87` |
| `Ctrl+C` | Abort in-flight turn (workflow screen) or exit otherwise | `src/hooks/use-app-keys.ts:39` |
| `Ctrl+C` ×2 | Force exit (within 2 seconds — `DOUBLE_PRESS_WINDOW_MS`) | `src/hooks/use-app-keys.ts:41` |
| `Esc` | Close the topmost overlay | `src/hooks/use-app-keys.ts:62` |

`Ctrl+C` behaviour on the workflow screen depends on phase: if a live phase is running (`isLivePhase` from `src/core/phases.ts`) and the workflow is not already cancelled, the first press calls `abortTurn`, marks the abort store as pending, kills tracked subprocesses via `killAllProcesses` (`src/lib/process/registry.ts`), and shows `"Aborting… Ctrl+C again to exit"`. A second press within the window exits.

### Home screen only

| Key | Action | Source |
|---|---|---|
| `Ctrl+S` | Open the skills overlay | `src/hooks/use-app-keys.ts:83` |
| `Ctrl+I` | Open the settings overlay (alternate binding) | `src/hooks/use-app-keys.ts:84` |

### Workflow screen

These keys are handled in `src/features/workflow/hooks/use-workflow-keys.ts` and routed through pure functions in `src/features/workflow/keyboard.ts`. They take effect only when no overlay is open and the input mode is `normal` (i.e. you are not typing in a prompt field).

| Key | Action | Source |
|---|---|---|
| `$` | Open the cost drilldown overlay (any key dismisses it) | `use-workflow-keys.ts:85` |
| `Ctrl+E` | Toggle the sidebar (only when terminal is wide enough) | `keyboard.ts:33` |
| `Ctrl+D` | Toggle the most recent diff in the conversation | `keyboard.ts:37` |
| `Esc` | Navigate home (only when the workflow has been cancelled) | `keyboard.ts:21` |
| `Shift+↑` | Scroll conversation up by one line | `keyboard.ts:69` |
| `Shift+↓` | Scroll conversation down by one line | `keyboard.ts:72` |
| `PageUp` | Scroll conversation up by one page | `keyboard.ts:76` |
| `PageDown` | Scroll conversation down by one page | `keyboard.ts:79` |
| `g` | Jump to top of conversation | `keyboard.ts:83` |
| `G` | Jump to bottom of conversation | `keyboard.ts:86` |

### Review pane (workflow screen, when a file is open)

When the review pane has a `filePath` set (e.g. inspecting a spec or plan), arrow keys scroll the review content instead of the conversation:

| Key | Action | Source |
|---|---|---|
| `↑` | Scroll review pane up one line | `keyboard.ts:53` |
| `↓` | Scroll review pane down one line | `keyboard.ts:54` |
| `G` | Jump to bottom of review pane | `keyboard.ts:55` |

### Summary screen

| Key | Action | Source |
|---|---|---|
| `Enter` | Continue (advertised in `keybindings.ts:23`) |

---

## Cross-reference: shortcuts declared in the keybinding registry

The `SHORTCUTS` table in `src/core/slash-commands/keybindings.ts:11` is the single source of truth for the labels rendered next to slash commands in the help overlay and command palette. Some entries are advisory (the actual handler is elsewhere), but the registry is what the UI reads:

| ID | Key | Description | Screens |
|---|---|---|---|
| `exit` | `Ctrl+C` | Exit (double-press) | all |
| `command-palette` | `Ctrl+K` | Command palette | all |
| `help` | `Ctrl+/` | Help | all |
| `quit` | `Ctrl+Q` | Quit | all |
| `skills` | `Ctrl+S` | Skills picker | home |
| `config` | `Ctrl+I` | Config picker | home |
| `settings` | `Ctrl+,` | Settings | all |
| `close-overlay` | `Esc` | Close overlay | all |
| `toggle-sidebar` | `Ctrl+E` | Toggle sidebar | workflow |
| `toggle-diff` | `Ctrl+D` | Toggle diff | workflow |
| `scroll` | `↑/↓` | Scroll | workflow |
| `continue` | `Enter` | Continue | summary |

---

## Index by command name

Alphabetical, for fast lookup:

- [`/approval`](#approval-listclear) — list or clear sticky approval grants.
- [`/attach`](#attach-path) — attach an image for the next planner call.
- [`/compact-transcript`](#compact-transcript) — summarize older persisted transcript turns.
- [`/config`](#settings-alias-config) — alias for `/settings`.
- [`/detach`](#detach-indexid) — remove a pending image attachment.
- [`/effort`](#effort-lowmediumhighxhigh) — set planner reasoning effort.
- [`/handoff`](#handoff-target-task-id) — export a Handoff Pack.
- [`/help`](#help) — open the help overlay.
- [`/home`](#home) — navigate to the home screen.
- [`/implementer`](#implementer) — open the implementer picker.
- [`/mode`](#mode-name) — switch workflow mode.
- [`/palette`](#palette) — open the command palette.
- [`/planner`](#planner) — open the planner picker.
- [`/queue`](#queue-showclear) — inspect or clear the planner message queue.
- [`/quit`](#quit) — exit the application.
- [`/redo-task`](#redo-task-id) — reset and re-run a single task.
- [`/refresh`](#refresh) — re-run tool detection.
- [`/repomap`](#repomap-rebuild) — manage the repo-map cache.
- [`/revise-plan`](#revise-plan-comment) — rewind to the plan phase.
- [`/revise-spec`](#revise-spec-comment) — rewind to the spec phase.
- [`/sessions`](#sessions) — browse past sessions.
- [`/settings`](#settings-alias-config) — open the settings overlay.
- [`/skills`](#skills) — pick planner skills (home only).

---

## See also

- [`docs/SLASH-COMMANDS.md`](./SLASH-COMMANDS.md) — the shorter overview document, useful as a quick refresher.
- [`docs/WORKFLOW.md`](./WORKFLOW.md) — workflow phases, modes, and the rewind state machine.
- [`docs/CONCEPTS.md`](./CONCEPTS.md) — shared vocabulary (phase, queue, awaiting-continue, etc.).
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the TUI, stores, engine, and runners are layered.
- [`docs/STORES.md`](./STORES.md) — `configStore`, `overlayStore`, `feedbackStore`, `lifecycleStore`, `routerStore`, `attachmentsStore`.
- [`src/core/slash-commands/catalog.test.ts`](../src/core/slash-commands/catalog.test.ts) — exhaustive phase / screen / arg matrix.
