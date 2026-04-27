# 03 — Brief/Code Drift Detector

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Detect mismatch between the final diff and the Task Brief contract before final planner review.

The detector should find:

- changed files outside all task scopes,
- tasks marked done/escalated whose target file did not change,
- failed tasks that left diffs behind,
- out-of-bounds file/symbol matches,
- missing expected evidence when an evidence ledger exists.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/core/schemas/task.ts`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/spec/prompts/review.ts`
- `src/lib/git.ts`
- `src/engine/events/types.ts`
- `src/core/schemas/evidence.ts` if spec 02 is implemented

## Files To Touch

- `src/core/paths.ts`
- `src/engine/orchestrator/drift.ts` new
- `src/engine/orchestrator/drift.test.ts` new
- `src/engine/orchestrator/final-review.ts`
- `src/engine/spec/prompts/review.ts`
- `src/engine/events/types.ts`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`

Do not touch implementers, parser, or cost code.

## Artifact

Add `DRIFT_REPORT_FILE = 'drift-report.json'` to `src/core/paths.ts`.

Write:

```text
.diptych/sessions/<id>/drift-report.json
```

Shape:

```ts
type DriftFinding = {
  severity: 'info' | 'warning' | 'error';
  code:
    | 'out_of_scope_file'
    | 'missing_expected_file'
    | 'orphan_diff'
    | 'out_of_bounds_text_match'
    | 'missing_evidence'
    | 'failed_task_with_diff';
  taskId?: TaskId;
  file?: string;
  message: string;
};

type DriftReport = {
  version: 1;
  passed: boolean;
  score: number;
  changedFiles: string[];
  expectedFiles: string[];
  findings: DriftFinding[];
};
```

Export these functions:

```ts
export function analyzeBriefDrift(input): DriftReport;
export function writeDriftReport(projectDir: string, sessionId: string, report: DriftReport): void;
export function formatDriftReportForPrompt(report: DriftReport): string;
```

## Rules

- Extra changed file not targeted by any task -> warning, or error if explicit out-of-bounds scope exists.
- Done/escalated task target file absent from changed files -> warning.
- Diff exists while all tasks are failed/skipped -> error.
- Failed task with changed file -> error.
- Out-of-bounds file path or quoted symbol appears in changed files/diff -> error. Match literally as a substring against each changed-file path and the raw git diff text; do not use regex or semantic matching.
- Evidence ledger expected evidence with no observed evidence -> warning.

Score:

- start at `1`
- error subtracts `0.25`
- warning subtracts `0.08`
- clamp `0..1`

`passed` means no errors.

## Final Review Integration

Before final planner review:

1. compute drift report,
2. persist `drift-report.json`,
3. publish compact event,
4. include report summary in final review prompt.

Prompt section:

```text
## Deterministic Drift Report
passed: false
score: 0.72
findings:
- [error] out_of_scope_file: src/foo.ts was changed but no Task Brief targets it.
```

Planner should treat error findings as review blockers unless it explains a false positive.

Use `getChangedFiles(projectDir)` and `getCurrentDiff(projectDir)` from `src/lib/git.ts`. Do not add another git wrapper unless the existing helpers cannot provide the required data.

## Event

Add this event variant:

```ts
| {
    type: 'drift_report';
    ts: number;
    phase: Phase;
    passed: boolean;
    score: number;
    errorCount: number;
    warningCount: number;
  }
```

Publish it before planner final review starts.

## Tests

- exact task files only passes,
- extra changed file warns/errors depending on scope,
- failed task with changed file errors,
- out-of-bounds match errors,
- missing evidence warns,
- score deterministic,
- final review prompt includes drift section.
- drift report persists cleanly when evidence is absent or empty
- drift_report event is emitted
- out-of-bounds matching is literal substring only, against changed file paths and raw diff text

## Acceptance Criteria

- Drift report is persisted.
- Final review receives deterministic drift context.
- Drift event/log is visible.
- Checker stays deterministic and does not attempt semantic code review.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/drift.test.ts src/engine/spec/prompts/review.test.ts
npm run typecheck
npm run lint
npm test
```
