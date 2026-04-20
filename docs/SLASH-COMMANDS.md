# Slash Commands

Runtime commands available during a diptych session. Type `/` in the TUI to open the command picker; the fuzzy matcher accepts partial names (e.g. `/rev-spec` resolves to `/revise-spec`). Each command runs against the current workflow state and either mutates it, opens an overlay, or prints feedback into the status line.

The full catalog lives in `src/core/slash-commands/catalog.ts`. Dispatch (name resolution + screen-guard enforcement) lives in `src/core/slash-commands/dispatch.ts`. The execution context (how a command reaches the stores / engine) is wired in `src/core/slash-commands/context.ts`.

## Availability

Every command declares `validScreens` — the screens on which it may run. Attempting to invoke a command on the wrong screen surfaces an error (`"/X is only available on the … screen."`). Screens are `home`, `workflow`, `summary`, `setup` (`src/stores/navigation/router.ts`).

Rewind-family commands (`/revise-spec`, `/revise-plan`, `/redo-task`) additionally gate on the current `Phase` via `phaseGuard`. The guard helpers (`canReviseSpec`, `canRevisePlan`, `canRedoTask`) are the single source of truth — see `src/core/slash-commands/catalog.ts` and `src/core/slash-commands/catalog.test.ts` for the exhaustive phase matrix.

## Command reference

### `/help`

- **Purpose**: open the help overlay (key bindings + command list).
- **Screens**: all.
- **Shortcut**: `Ctrl+/`.
- **Example**: `/help`
- **Implementation**: `src/core/slash-commands/catalog.ts` — calls `ctx.openOverlay('help')`.

### `/palette`

- **Purpose**: open the command palette (searchable list of all palette-eligible commands).
- **Screens**: all.
- **Shortcut**: `Ctrl+K` (`src/core/slash-commands/keybindings.ts`).
- **Example**: `/palette`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('command-palette')`.

### `/skills`

- **Purpose**: pick planner skills for the upcoming session (skill overlay).
- **Screens**: `home` only.
- **Shortcut**: `Ctrl+S`.
- **Example**: `/skills`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('skills')`.

### `/sessions`

- **Purpose**: browse past sessions (opens the sessions overlay backed by `.diptych/sessions/`).
- **Screens**: all.
- **Example**: `/sessions`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('sessions')`.

### `/settings` (alias `/config`)

- **Purpose**: open the settings overlay (planner, model, workflow defaults).
- **Screens**: all.
- **Shortcut**: `Ctrl+,`.
- **Example**: `/settings` or `/config`.
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('settings')`.

### `/mode <quick|standard|full>`

- **Purpose**: switch workflow mode at runtime. With no argument, opens the mode-selector overlay. With a valid mode, persists it via `configStore.save(...)` so subsequent runs inherit the change.
- **Screens**: all.
- **Args**: one of `quick`, `standard`, `full` (`WORKFLOW_MODES` in `src/core/schemas/enums.ts`). Invalid values produce an error message listing the valid set.
- **Example**: `/mode full`
- **Implementation**: `src/core/slash-commands/catalog.ts`; persistence in `src/core/slash-commands/context.ts` (calls `configStore.save`). Mode semantics: `docs/WORKFLOW.md` §1.2.

### `/planner`

- **Purpose**: open the planner picker (choose / reconfigure the planner runner).
- **Screens**: all.
- **Example**: `/planner`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('planner-picker')`.

### `/implementer`

- **Purpose**: open the implementer picker (choose / reconfigure the implementer runner).
- **Screens**: all.
- **Example**: `/implementer`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.openOverlay('implementer-picker')`.

### `/home`

- **Purpose**: navigate back to the home screen from an active workflow or summary screen.
- **Screens**: `workflow`, `summary`.
- **Example**: `/home`
- **Implementation**: `src/core/slash-commands/catalog.ts` — `ctx.navigate('home')`.

### `/refresh`

- **Purpose**: re-run tool detection (planner/implementer CLIs, API endpoints) and refresh availability state.
- **Screens**: all.
- **Example**: `/refresh`
- **Implementation**: `src/core/slash-commands/catalog.ts`; detection in `src/engine/detection/service.ts` via `refreshDetection(projectDir)`.

### `/revise-spec [comment]`

- **Purpose**: rewind to the spec phase. With a comment, the next planning run regenerates `spec.md` using the comment as feedback. Without a comment, the workflow jumps to the spec approval gate without regenerating.
- **Screens**: `workflow`.
- **Phase guard**: `canReviseSpec` — allowed from `reviewing-spec` onward (`reviewing-spec`, `planning`, `reviewing-plan`, `implementing`, `validating-task`, `escalating`, `final-review`). Denied in `idle`, `researching`, `specifying`, `complete`.
- **Example**: `/revise-spec the validator should also strip whitespace`
- **Implementation**: `src/core/slash-commands/catalog.ts` dispatches `REWIND_TO_SPEC` via `requestRewind('spec', comment)` in `src/features/workflow/handlers.ts`. Fast-path regeneration lives in `src/engine/orchestrator/planning.ts`. See `docs/WORKFLOW.md` §1.1.

### `/revise-plan [comment]`

- **Purpose**: rewind to the plan phase (spec is preserved). With a comment, `plan.md` / `tasks.md` are regenerated using the comment; without a comment, the workflow jumps to the plan approval gate.
- **Screens**: `workflow`.
- **Phase guard**: `canRevisePlan` — allowed from `reviewing-plan` onward.
- **Example**: `/revise-plan split task T003 into smaller steps`
- **Implementation**: `src/core/slash-commands/catalog.ts` dispatches `REWIND_TO_PLAN` via `requestRewind('plan', comment)`. See `docs/WORKFLOW.md` §1.1.

### `/redo-task <id>`

- **Purpose**: reset a single task to `pending` and re-run it; does not trigger replanning. The task loop picks it up on its next iteration.
- **Screens**: `workflow`.
- **Phase guard**: `canRedoTask` — `implementing`, `validating-task`, or `escalating` only.
- **Args**: task ID (e.g. `T001`). Required — calling without an ID produces a usage error.
- **Example**: `/redo-task T003`
- **Implementation**: `src/core/slash-commands/catalog.ts` dispatches `RESET_TASK` via `requestRewind({ target: 'task', taskId })` in `src/features/workflow/handlers.ts`.

### `/queue [show|clear]`

- **Purpose**: inspect or clear the planner message queue. `show` (default) reports the queue depth; `clear` drains all queued messages.
- **Screens**: `workflow`.
- **Args**: `show` (default) or `clear`. Other values produce a usage error.
- **Example**: `/queue show`, `/queue clear`, `/queue`.
- **Implementation**: `src/core/slash-commands/catalog.ts`; depth from `lifecycleStore.get().queueDepth`; clear via `requestClearQueue()` in `src/features/workflow/handlers.ts`. Queue semantics: `docs/WORKFLOW.md` §1.6–1.7.

### `/repomap rebuild`

- **Purpose**: clear the repo-map cache so the next planner phase re-parses from scratch.
- **Screens**: all.
- **Args**: `rebuild` is the only accepted sub-command; anything else (or no sub-command) produces a usage error.
- **Example**: `/repomap rebuild`
- **Implementation**: `src/core/slash-commands/catalog.ts`; cache clearing in `src/engine/codebase/rebuild.ts`. See `docs/REPOMAP.md`.

### `/quit`

- **Purpose**: exit the application.
- **Screens**: all.
- **Shortcut**: `Ctrl+Q`.
- **Example**: `/quit`
- **Implementation**: `src/core/slash-commands/catalog.ts` — calls the `exit` callback wired in `src/core/slash-commands/context.ts`.

## How commands are dispatched

1. The TUI input component splits on whitespace: `parts[0]` is the command name, the remainder (if any) is the argument string.
2. `executeSlashCommand` (`src/core/slash-commands/dispatch.ts`) resolves the name — first by exact match against `name` and `aliases`, then by fuzzy match via `fzf` (tolerates typos).
3. If the command's `validScreens` does not include the current screen, the dispatcher emits an error through `feedbackStore` and returns.
4. Otherwise the handler runs with the parsed args. Commands reach the stores and engine through the `CommandContext` assembled in `src/core/slash-commands/context.ts` (no direct store imports from the catalog).
5. Rewind-family handlers additionally re-check their `phaseGuard` before delegating to `requestRewind` / `requestTaskRedo`, so a stale picker cannot bypass the state machine.

Command palette items (`Ctrl+K`) are derived from the same catalog via `toPaletteItems`; commands without a `label` field are excluded from the palette but remain callable via `/name`.

## Adding a new command

1. Add an entry to `src/core/slash-commands/catalog.ts`. Pick `kind: 'noarg'` or `kind: 'arg'`, declare `validScreens`, and (if the command mutates workflow state) supply a `phaseGuard`.
2. Extend `CommandContext` in `src/core/slash-commands/types.ts` if the handler needs a new capability, and wire the implementation in `src/core/slash-commands/context.ts`.
3. Add a behaviour test in `src/core/slash-commands/catalog.test.ts` — cover the happy path plus at least one guard failure (wrong screen, wrong phase, missing args, invalid args).
4. If the command is visible to end users, update this file with an entry in the same shape as the sections above.

## See also

- `docs/WORKFLOW.md` — workflow phases, modes, interaction model, rewind semantics.
- `docs/CONCEPTS.md` — shared vocabulary (phase, queue, awaiting-continue).
- `docs/ARCHITECTURE.md` — how the TUI, stores, and engine are layered.
- `docs/STORES.md` — `configStore`, `overlayStore`, `feedbackStore`, `lifecycleStore`, `routerStore`.
