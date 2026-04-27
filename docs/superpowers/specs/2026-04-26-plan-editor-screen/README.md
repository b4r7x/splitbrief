# Plan Editor Screen — 2026-04-26

> **Status:** draft spec.
> **Scope:** replace the passive `BriefReviewView` with a first-class interactive plan editor TUI for `standard` and `speckit` users during the `reviewing-briefs` phase.
> **Out of scope:** changes to the engine-side state machine for `reviewing-briefs`; new workflow phases; changes to the simple approve/reject view used by `quick` mode; any agent-SDK or external-handoff surface; implementing the plan editor for `instant` or `quick` modes.

## Purpose

The planner produces a `tasks.md` file containing sequenced Task Briefs. Before implementation begins, `standard` and `speckit` users currently see a read-only list with approve/edit/comment/reject text commands. This spec replaces that passive view with a lazygit-style interactive plan editor: cursor navigation, delete, merge, split, reorder, external editor, and atomic save — all operating on the in-memory task list before committing to disk.

The product invariant this adds:

> The user can sculpt the task plan before any implementer token is spent. Each edit operation maintains internal coherence — renumbering, dependency transitivity, and brief-quality validation happen on every save.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Architecture and product decisions. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies. |
| 4 | `agent-briefs/01-plan-editor-store.md` | Editor state store. |
| 5 | `agent-briefs/02-plan-editor-actions.md` | Pure action handlers for delete/merge/split/reorder. |
| 6 | `agent-briefs/03-plan-editor-component.md` | TUI component rendering the editable task list. |
| 7 | `agent-briefs/04-keystroke-bindings.md` | `useInput` integration, modal help overlay. |
| 8 | `agent-briefs/05-save-and-commit.md` | Atomic save: disk write, brief-quality regeneration, loop re-parse, APPROVE_BRIEFS dispatch. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Plan editor store | Module-scoped state for cursor, task list, dirty flag, expand state. |
| 02 | Plan editor actions | Pure `(Task[], cursor) => Task[]` functions for each edit operation. |
| 03 | Plan editor component | Ink component mounted when `briefReview === 'rich'` and phase is `reviewing-briefs`. |
| 04 | Keystroke bindings | `usePlanEditorKeys` hook; modal help overlay via `overlayStore`. |
| 05 | Save and commit | Atomic write of `tasks.md`, brief-quality regeneration, engine re-parse, dispatch `APPROVE_BRIEFS`. |

## Dependencies

- **Phase 3 brief-review-gate** — `runBriefsApprovalLoop` in `src/engine/orchestrator/planning/shared.ts` calls `callbacks.onApprovalNeeded('briefs', tasksFilePath)`. Brief 05 specifies a targeted change to this loop: after `onApprovalNeeded` resolves with `approved: true`, re-read `tasksFilePath` from disk and re-parse before handing tasks to the implementation path.
- **Brief quality gate** — `src/engine/spec/brief-quality.ts` and `src/core/paths.ts` (`BRIEF_QUALITY_FILE`) already exist from the Task Brief Evidence Contract spec.
- **`BriefReviewView`** — the existing simple view at `src/features/workflow/components/brief-review-view.tsx` is **not removed**. The plan editor coexists via a config flag branch in `screen.tsx`.
- **`overlayStore`** — `'plan-editor-help'` is added to the `OverlayType` union in `src/stores/navigation/router.ts`.

## Done Criteria

- `npm run test-ci` passes (typecheck → lint → test).
- The plan editor mounts when `config.workflow.briefReview === 'rich'` during `reviewing-briefs`.
- The simple `BriefReviewView` continues to mount when `config.workflow.briefReview !== 'rich'` (default path unchanged).
- `e` from the simple view activates the rich editor for the current session (in-memory flag, not persisted to config).
- All keystroke operations (d/m/s/e/<c-j>/<c-k>/j/k/arrows/enter/?/Y/q) produce correct in-memory task state per the action contracts in brief 02.
- `Y` atomically writes `tasks.md`, regenerates `brief-quality.json`, validates the round-trip parse, and dispatches `APPROVE_BRIEFS`. If validation fails, the editor stays open with an error message.
- `q` discards all edits and returns to the simple view without touching disk.
- After an approved save, `runBriefsApprovalLoop` re-parses `tasks.md` so the implementation path receives the user-edited tasks, not the planner's original in-memory list.
- No classes. No barrels. No `useMemo`/`useCallback`/`React.memo`/`forwardRef`. ESM `.js` imports. kebab-case files.

## Quality Bar For Implementing Agents

- Pure action functions must have full unit tests with fixture `Task[]` arrays — no mocking of React, Ink, or store internals.
- The save path must be tested with a temp directory: write → parse → compare IDs. Do not skip the round-trip check.
- Keystroke handler must be a pure function returning an action variant, tested independently of `useInput`.
- Do not collapse `'plan-editor-help'` into the existing `'help'` overlay type — add the dedicated variant.
- External editor (`e`) suspends Ink stdin via `process.stdin.pause()` / `.resume()` and awaits the child process exit synchronously in the async handler. The temp file path is the session's `tasks.md`.
- Dependency adjustment after delete uses transitive relinking, not a block-and-warn. After merge, `dependsOn` is the set-union of both tasks minus any reference to the absorbed task.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only.
- UI: Ink 6 + React 19.
- Tests: Vitest 4, colocated.
- Store pattern: `createStore` + `storeBase` from `src/stores/create-store.ts`. Read via `.use(selector)`. Never `useMemo`.
- Config schema: `src/core/config/schema.ts` (add `workflow.briefReview` field there and in `docs/CONFIG.md`).
- Markdown transport: `tasks.md`. Parser: `src/engine/spec/parser.ts` → `parseTasks(text): Task[]`.
- Never run `git add`, `git stage`, or `git commit`.
