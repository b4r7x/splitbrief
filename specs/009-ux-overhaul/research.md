# Research: 009-ux-overhaul

## 1. State Machine Extensions

**Decision**: Add 1 new phase (`review-gate`) and 5 new transitions (`BACK_TO_SPEC`, `BACK_TO_PLAN`, `APPROVE_GATE`, `PLAN_COMPLETE`, `SET_MODE`) to the existing state machine.

**Rationale**: The current 11-phase, 20-transition state machine needs minimal extension. Back navigation requires new transitions between existing phases. The review gate needs a new phase inserted between `reviewing-plan` and `implementing`. PermissionMode is orthogonal state (not a phase) stored as a field on WorkflowState.

**Key findings**:
- Current `REJECT_SPEC` and `REJECT_PLAN` go to `idle` (terminate workflow). The comment→regenerate→re-review loop is handled imperatively in the orchestrator via `while` loops, NOT by state transitions. This is correct and doesn't need changing.
- `APPROVE_PLAN` currently goes directly to `implementing`. Must change to `review-gate`.
- New `APPROVE_GATE` handles `review-gate` → `implementing` (moves the `currentTaskIndex=0, attempt=0` reset logic from APPROVE_PLAN).
- `PLAN_COMPLETE` handles plan-only mode: `review-gate` → `complete`.
- `SET_MODE` mutates `permissionMode` without changing phase (like existing `SET_SESSION_ID`).
- `stateVersion` must bump from 2 to 3. Add migration logic for old state files (set `permissionMode: 'normal'` as default).

**Alternatives considered**:
- Modeling PermissionMode as phases (rejected: it's orthogonal to workflow phase, not sequential)
- Adding regeneration as state transitions (rejected: imperative while-loop pattern already works well)
- Keeping APPROVE_PLAN → implementing and skipping review-gate (rejected: spec requires explicit pre-implementation checkpoint)

## 2. TUI Component Architecture

**Decision**: Add screen router at App level with 3 screens (home/workflow/summary). Add overlay system for mode picker and help. Keep props-based data flow.

**Rationale**: Current component tree has App → Layout → children with all state in App via useState. The workflow starts unconditionally in useEffect on mount — must be deferred for home screen. Adding a screen router is the minimal change that supports home screen + workflow + summary.

**Key findings**:
- App holds all state via useState (events, phase, approval, inputMode, screen). No React Context used.
- Layout takes 11 props — already heavy. Adding more would be unwieldy but manageable.
- Ink's `useInput` fires in ALL mounted components simultaneously — no focus system. Must add guards (check active screen/overlay before processing keys).
- Current screen switching is binary: `'workflow' | 'summary'`. Extend to `'home' | 'workflow' | 'summary'`.
- The `useEffect` that calls `runWorkflow()` runs on mount — must be triggered by callback from HomeScreen instead.
- The `<Select>` component from `@inkjs/ui` (already used in picker.tsx) is the right primitive for mode picker overlay.

**Alternatives considered**:
- React Context for state management (rejected: overkill for current scale, props drilling is manageable)
- Separate process for home screen (rejected: Ink handles full-screen TUI fine, no need for separate lifecycle)
- Custom focus management library (rejected: guard pattern with active screen/overlay state is simpler)

## 3. Orchestrator Callback Flow

**Decision**: Restructure the linear spec→plan→implement flow into a navigable loop. Add new callbacks for review gate, task-level approval, and mode changes.

**Rationale**: The current orchestrator has a linear flow: spec review while-loop → plan review while-loop → task loop. Back navigation requires restructuring this into an outer loop that dispatches based on current phase. New callbacks are needed for supervised mode.

**Key findings**:
- Spec review (lines 391-416) and plan review (lines 432-457) are independent while-loops with comment/regeneration support via `planner.regenerate()`.
- The review gate insertion point is at line 465-467 (between `} // end if (!savedState)` and task loop start).
- Pre-task approval goes between dependency check (line 503) and task start (line 506).
- Post-task review goes after `validateCommitAndAdvance` success (line 575).
- `auto` flag is checked in App callbacks (lines 61, 102, 129), NOT in orchestrator. Config's `autoApproveSpec/Plan` is checked in orchestrator (lines 391, 432). Dual mechanism needs unification.
- SIGINT handler (line 274) calls `process.exit(130)` immediately. For back-navigation UX, first SIGINT should pause, second should exit.

**New callbacks needed**:
- `onReviewGate(tasks, config)` → `Promise<'proceed' | 'back' | 'quit'>`
- `onTaskApproval?(task)` → `Promise<'proceed' | 'skip' | 'edit'>`
- `onTaskReview?(task, diff, validation)` → `Promise<'commit' | 'retry' | 'skip' | 'edit'>`

**Alternatives considered**:
- Passing PermissionMode directly to orchestrator instead of callbacks (rejected: orchestrator shouldn't know about TUI concerns, callbacks are the abstraction boundary)
- Single mega-callback replacing all approval types (rejected: each approval type has different return options)

## 4. CLI Entry Point and Config

**Decision**: Add default `.action()` on root commander program for home screen. Add `--mode` flag, keep `--auto` as alias for `--mode auto`. Add `mode` to Config.workflow.

**Rationale**: Commander supports a default action when no subcommand is given — this is the standard way to handle `tiny-spec` with no arguments. The `--mode` flag replaces the boolean `--auto` with a richer set of options while maintaining backwards compatibility.

**Key findings**:
- Commander's root `.action()` fires when no subcommand matches. Subcommands still work normally. `--help` and `--version` still work.
- Config is loaded TWICE: once in cli.ts (for capability detection) and once in app.tsx useEffect. Should unify.
- `--auto` currently sets a prop on App, which auto-resolves approval callbacks. `config.workflow.autoApproveSpec/Plan` are separate booleans checked in orchestrator. Dual mechanism.
- `mode` field goes in `Config.workflow`. Precedence: CLI flag > runtime switch > config file > default (normal).
- The existing Picker component in `picker.tsx` uses `@inkjs/ui` `<Select>` — same primitive for mode picker overlay.

**Migration plan**:
- Keep `--auto` flag, map to `--mode auto` internally
- Keep `autoApproveSpec/Plan` in config for backwards compat, derive from `mode` if `mode` is set
- Add `mode?: PermissionMode` to Config.workflow (optional, defaults to `'normal'`)

## 5. TLDR Changeset Parser

**Decision**: Create `tldr-parser.ts` following the exact pattern of `question-parser.ts`. Add TLDR generation instruction to `buildRegeneratePrompt()`.

**Rationale**: The existing question parser uses a proven pattern: marker prefix/suffix scanning, balanced-brace JSON extraction, streaming accumulator. This pattern is directly replicable for TLDR markers with different field validation.

**Key findings**:
- Question parser uses `<!-- Q:` prefix and ` -->` suffix, manual scanning (not regex), balanced-brace finder for JSON
- Accumulator pattern handles streaming: `addChunk()` returns only new items, deduplicates by ID, trims buffer
- `buildRegeneratePrompt()` (templates.ts line 196) is the insertion point for TLDR instructions. Currently minimal (label, current content, feedback, regeneration instruction).
- TLDR instruction should request `<!-- TLDR:{"added":[],"changed":[],"removed":[],"summary":""} -->` format
- Only emit TLDR event on regeneration (not first generation) — controlled by only adding TLDR instruction to regeneration prompts, not to initial generation prompts

**TLDR marker format**:
```
<!-- TLDR:{"added":["US-5 OAuth2 provider"],"changed":["US-1 login flow"],"removed":["FR-012 password hashing"],"summary":"4 stories -> 5 | 24 FRs -> 22"} -->
```

## 6. Testing Patterns

**Decision**: Follow existing patterns — `node:test` + `node:assert/strict`, dynamic imports with `.js` extensions, component-as-function testing for pure components, factory functions for test data.

**Rationale**: The project uses Node.js built-in test runner exclusively. No external test dependencies. Component tests call React components as plain functions and inspect the returned element tree.

**Key findings**:
- Framework: `node:test` + `node:assert/strict` (zero external deps)
- Execution: `tsx --test tests/**/*.test.ts`
- Component testing: call component as function, walk `props.children` with local helpers (`collectText`, `findText`)
- Ink rendering tests: `PassThrough` stream pattern exists in `tests/helpers/render.tsx` but is hardcoded to TaskSummary — needs generalization
- State tests: pure function testing of `transition()` with factory helpers
- Orchestrator tests: only test exported utility functions, not the full workflow
- Naming: `<module>.test.ts`, describe blocks match export names, it blocks describe behavior

**New test files needed**:
- `tests/tldr-parser.test.ts` (following question-parser.test.ts pattern)
- `tests/home-screen.test.ts` (new component)
- `tests/mode-picker.test.ts` (new component)
- `tests/review-gate.test.ts` (new component)
- `tests/dialog-card.test.ts` (refactored event-card)
- Updated: `tests/state.test.ts` (new transitions), `tests/orchestrator.test.ts` (new callbacks)
