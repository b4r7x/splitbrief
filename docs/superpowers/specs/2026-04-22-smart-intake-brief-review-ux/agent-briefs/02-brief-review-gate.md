# 02 — Brief Review Gate

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add a user review surface for compiled Task Briefs before implementation starts.

Users inspect:

- task ids/titles/files,
- dependencies,
- scope,
- validation,
- escalation,
- evidence,
- quality score/issues, rendering `quality n/a` when no quality report exists.

Then approve, reject, or request regeneration with a comment.

Users can also open the generated `tasks.md` Task Brief transport in their text editor, make manual edits, return to the TUI, and approve the edited brief if it still parses and passes the Task Brief quality gate.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `docs/WORKFLOW.md`
- `src/core/state/machine.ts`
- `src/engine/orchestrator/approval.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/features/workflow/screen.tsx`
- `src/features/workflow/review-parser.ts`
- `src/features/workflow/components/review-view.tsx`
- `src/stores/workflow/review.ts`

## Files To Touch

- `src/core/state/machine.ts`
- `src/core/phases.ts`
- `src/core/schemas/enums.ts`
- `src/core/types/state-actions.ts`
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/spec/parser.ts`
- `src/engine/orchestrator/approval.ts`
- `src/features/workflow/components/brief-review-view.tsx` new
- `src/features/workflow/review-parser.ts`
- `src/stores/workflow/review.ts`
- docs: `docs/WORKFLOW.md`, `docs/TASK-CONTRACT.md`

Do not implement inline field editing. Use approve/reject/comment regeneration.

## Product Behavior

Add an explicit `reviewing-briefs` phase. Do not reuse `reviewing-plan`.

Add these state actions:

```ts
| { type: 'BRIEFS_READY'; tasks: Task[] }
| { type: 'APPROVE_BRIEFS' }
| { type: 'REJECT_BRIEFS' }
```

Transitions:

- `BRIEFS_READY` -> `phase: 'reviewing-briefs'`, `tasks: action.tasks`
- `APPROVE_BRIEFS` -> `phase: 'implementing'`, `currentTaskIndex: 0`, `attempt: 0`
- `REJECT_BRIEFS` -> `phase: 'idle'`

Extend `OrchestratorCallbacks.onApprovalNeeded` type from `'spec' | 'plan'` to `'spec' | 'plan' | 'briefs'`.

Default gates:

- `instant`: no brief review.
- `quick`: no brief review by default, but allow config/CLI later if existing approval model supports it.
- `standard`: brief review after tasks compile, before implementation.
- `speckit`: brief review after analyze, before implementation.

Hardcode v1 to `standard` and `speckit`. Do not add a config key in this brief.

Review actions:

- approve -> implementation starts.
- comment -> call existing task regeneration path (`regenerateTasks`) and show review again.
- edit -> open `tasks.md` in `$EDITOR`, then reload and validate the file before approval is allowed.
- reject -> cancel workflow.

## Manual Editor Flow

Reuse the existing editor behavior in `src/features/workflow/review-parser.ts`: `edit` opens the current review file with `process.env.EDITOR || 'vi'`.

For `reviewing-briefs`, the review file must be the absolute path to `.diptych/sessions/<id>/tasks.md`.

After the editor exits:

1. read `tasks.md`,
2. parse it with `parseTasks`,
3. run the Task Brief quality gate from `src/engine/spec/brief-quality.ts`,
4. update workflow state tasks with the parsed tasks only if parsing succeeds and the quality report has no errors,
5. persist the updated `state.json` and `brief-quality.json`,
6. show a success feedback message with the parsed task count.

If parsing or quality validation fails:

- keep the user in `reviewing-briefs`,
- do not update `state.tasks`,
- show an error containing the parser/quality failure,
- leave the edited `tasks.md` on disk so the user can run `edit` again and fix it.

Do not auto-regenerate after manual edits fail. Manual edit failure is user-correctable.

## UI

Render compact task list:

```text
Task Briefs  4 tasks  quality 0.91
✓ T001 src/foo.ts        Add parser guard
  validation: 3 checks · evidence: 2 · scope: set
⚠ T002 src/bar.ts        Update UI copy
  missing evidence
```

Selecting a task is not in v1. Render all tasks as condensed rows and show the full details path (`tasks.md`) in the header.

Input hint:

```text
approve | edit | comment <text> | reject
```

## Tests

- state machine can enter and leave `reviewing-briefs`.
- approving starts implementation.
- rejecting cancels.
- comment path calls existing regeneration flow or returns to planning with comment.
- edit path opens `tasks.md`, reloads edits, parses tasks, runs quality gate, and updates state on success.
- invalid manual edit keeps the review gate open and does not mutate `state.tasks`.
- component renders tasks, scope/validation/evidence counts, and quality warnings.

Test behavior, not hook internals.

## Acceptance Criteria

- Users can review compiled Task Briefs before implementation in standard/speckit.
- Users can manually edit `tasks.md` in `$EDITOR` during brief review.
- Edited `tasks.md` must parse and pass quality gate before approval can proceed.
- Review surface is readable in small terminals.
- No inline TUI field editor; manual editing happens in the external editor.
- Existing spec/plan gates still work.

## Verification Commands

```bash
npm test -- src/core/state/machine.test.ts src/features/workflow/review-parser.test.ts
npm run typecheck
npm run lint
npm test
```
