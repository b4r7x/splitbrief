# 02 - Task Brief Planning Contract

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Close the Task Brief contract so invalid briefs cannot reach implementation, review edits are validated according to spec, and evidence/brief hash artifacts stay complete.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-22-cost-aware-task-compiler/README.md`
- `docs/superpowers/specs/2026-04-22-task-brief-evidence-contract/README.md`
- `docs/superpowers/specs/2026-04-22-smart-intake-brief-review-ux/README.md`
- `docs/superpowers/specs/2026-04-26-brief-hash-versioning/README.md`
- `src/engine/spec/brief-quality.ts`
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/orchestrator/planning/new.ts`
- `src/engine/orchestrator/planning/speckit.ts`
- `src/engine/orchestrator/planning/mode-advisor.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/evidence.ts`
- `src/engine/orchestrator/drift.ts`
- `src/engine/spec/prompts/instant.ts`
- `src/engine/spec/prompts/quick-plan.ts`

## Scope

**In bounds:**

- Hard quality gate behavior for `standard` and `speckit`.
- Brief review edit/approve flow: read `tasks.md`, parse, quality-gate, then approve.
- Documented fallback when `tasks.md` is missing/empty/unreadable at approval.
- Spec-compatible `edit` behavior for the `reviewing-briefs` phase.
- Prompt boundary consistency for `instant` and `quick`.
- Evidence ledger retention of validation failure details across retry/escalation.
- Active `briefHash` propagation into evidence and drift artifacts.
- Smart intake missing-context and missing-validation hint coverage.
- Cost/risk summary values passed into summary generation when already available.

**Out of bounds:**

- New Task schema fields.
- New planner regeneration loops.
- Rewriting the parser.
- UI redesign beyond error/status text needed for this contract.

## Required Fixes

### 1. Quality gate is hard in every mode

`runBriefQualityGate(...)` must block implementation when it returns not ok in:

- `instant`,
- `quick`,
- `standard`,
- `speckit`.

For reviewed modes, user approval cannot override quality errors. Warnings may still allow approval.

### 2. Brief review edit follows the spec contract

The `edit` action in `reviewing-briefs` must open `.diptych/sessions/<id>/tasks.md` in `$EDITOR`, then reload the file, parse it, run the quality gate, and keep the review gate open on parse or quality errors.

If the rich in-app plan editor remains available, it must be a separate explicit action or a compatible implementation detail that still writes and validates the same persisted `tasks.md`. It must not replace the documented external-edit contract unless docs and tests are updated in the same brief.

### 3. Brief review approve follows persisted `tasks.md`

On approve:

1. Read `.diptych/sessions/<id>/tasks.md`.
2. Parse it.
3. If the file is missing, rewrite it from the current in-memory tasks and reparse once.
4. If parsing fails or the reparsed task list is empty, stay in `reviewing-briefs` with a concise error.
5. Run the quality gate on the final task list.
6. Block approval on parse or quality errors.

The user-facing error should explain whether the failure is parse, empty task list, or quality gate.

Never approve stale in-memory tasks after a failed parse.

### 4. Prompt boundary is consistent

`instant` and `quick` prompts must not describe scope, escalation, or evidence as optional when the Task Brief v1 contract requires those sections. Update prompt text and tests to match the contract.

### 5. Evidence keeps validation failure detail

When validation fails and the task is retried/escalated, the evidence ledger must retain the initial validation failure details. Do not only record the final retry outcome.

Each failed validation entry should preserve stage, `passed: false`, short error summary, retry/escalation state, and changed files when available.

### 6. Brief hash is present where promised

Runtime evidence entries and drift reports must carry the active `briefHash` where the 2026-04-26 brief hash spec says they do. Do not add `briefHash` to Task schema unless the original brief explicitly requires it.

New artifacts should write `briefHash` as a string or `null`, not omit it, where the artifact schema promises the field.

### 7. Smart intake hints match spec

Mode advisor should flag:

- non-trivial prompt with no area/file/module,
- no validation hint,
- vague target,
- missing done criteria.

Keep the classifier local and deterministic.

## Acceptance Criteria

- Invalid Task Briefs cannot enter implementation in any workflow mode.
- Brief review edit opens and validates the persisted `tasks.md` contract.
- Brief review approval validates the persisted `tasks.md`.
- Missing `tasks.md` is rewritten from current tasks and reparsed once; parse/empty failures do not approve stale memory.
- Prompt text does not weaken the Task Brief v1 contract.
- Evidence includes validation failure details before retry/escalation.
- Evidence and drift artifacts include active `briefHash` where promised.
- Smart intake emits the missing-context/no-validation hints listed above.
- Summary includes available cost/risk prediction data instead of silently dropping it.

## Tests

Add or update behavior tests for:

- `standard` invalid brief blocks implementation,
- `speckit` invalid brief blocks implementation,
- `reviewing-briefs` edit opens/reloads/quality-gates persisted `tasks.md`,
- approval after editing `tasks.md` runs parse and quality gate,
- missing/empty `tasks.md` fallback behavior,
- instant/quick prompt contract text,
- validation failure retained in evidence after retry,
- drift/evidence artifacts include `briefHash`,
- smart intake missing area/file/module and missing validation hints.

## Verification Commands

```bash
npm test -- src/engine/spec src/engine/orchestrator/planning src/engine/orchestrator
npm run typecheck
npm run lint
npm test
```
