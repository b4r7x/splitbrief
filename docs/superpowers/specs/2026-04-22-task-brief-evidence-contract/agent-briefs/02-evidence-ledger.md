# 02 — Evidence Ledger

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Persist a compact evidence ledger for each run and render it in the summary UI.

Evidence should show:

- task id/title/file/status,
- completion method,
- retries,
- validation stages,
- changed files,
- expected evidence from the Task Brief,
- observed evidence from execution,
- escalation status,
- final-review artifact status.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/core/schemas/summary.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/validation.ts`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/orchestrator/summary.ts`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/summary-task-table.tsx`

## Files To Touch

- `src/core/paths.ts`
- `src/core/schemas/evidence.ts` new
- `src/engine/orchestrator/evidence.ts` new
- `src/engine/orchestrator/evidence.test.ts` new
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/summary/components/summary-evidence.tsx` new
- `src/features/summary/components/summary-evidence.test.tsx` new
- `src/features/summary/screen.tsx`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`

Do not touch planner prompts or provider pricing.

## Artifact

Add `EVIDENCE_FILE = 'evidence.json'` to `src/core/paths.ts`.

Write:

```text
.diptych/sessions/<id>/evidence.json
```

Shape:

```ts
type EvidenceLedger = {
  version: 1;
  sessionId: string;
  feature: string;
  mode?: WorkflowMode;
  generatedAt: string;
  tasks: EvidenceTask[];
  validationSummary: {
    passed: number;
    failed: number;
    skipped: number;
    escalated: number;
  };
  finalReview?: {
    path: string;
    status: 'written' | 'failed' | 'skipped';
  };
};

type EvidenceTask = {
  id: TaskId;
  title: string;
  file: string;
  status: TaskStatus;
  method?: TaskCompletionMethod;
  retries: number;
  durationMs?: number;
  changedFiles: string[];
  validation: Array<{
    stage: 'tsc' | 'lint' | 'test';
    passed: boolean;
    errorSummary?: string;
  }>;
  expectedEvidence: string[];
  observedEvidence: string[];
  escalated: boolean;
};
```

Also add this optional summary field in `src/core/schemas/summary.ts`:

```ts
evidenceSummary: z.object({
  path: z.string(),
  totalTasks: z.number().nonnegative(),
  tasksWithValidationEvidence: z.number().nonnegative(),
  escalatedTasks: z.number().nonnegative(),
  failedTasks: z.number().nonnegative(),
}).optional()
```

## Collection Rules

Expected evidence:

- `task.evidence`
- task validation items from `task.tests`
- dependency-skip evidence from `handleSkippedTask(...)`

Observed evidence:

- task reached `done` or `escalated`
- validation stage passed
- diff/write was produced for target file
- final review was written

Persist after each task terminal event and again after final review.

Existing sessions without `evidence.json` must still load.

## Integration Points

Implement these pure helpers in `src/engine/orchestrator/evidence.ts`:

```ts
export function createEvidenceLedger(input): EvidenceLedger;
export function recordLocalTaskEvidence(input): EvidenceLedger;
export function recordRetryOrEscalationEvidence(input): EvidenceLedger;
export function recordSkippedTaskEvidence(input): EvidenceLedger;
export function recordFinalReviewEvidence(input): EvidenceLedger;
export function buildEvidenceSummary(ledger: EvidenceLedger): Summary['evidenceSummary'];
export function writeEvidenceLedger(projectDir: string, sessionId: string, ledger: EvidenceLedger): void;
export function readEvidenceLedger(projectDir: string, sessionId: string): EvidenceLedger | null;
```

Wire them in `task-step.ts`:

- after `validateCommitAndAdvance(...)` completes locally, record validation results and local completion evidence;
- after `retryAndRecord(...)`, record failed/escalated evidence based on returned state and recorded task status;
- after pre-task or dependency skip, record skipped evidence.

Wire them in `task-loop.ts`:

- when `handleSkippedTask(...)` skips a task because a dependency failed, persist skipped evidence with the dependency reason so the ledger reflects the skip cause.

Wire `final-review.ts`:

- after review artifact is written or final review fails, update `finalReview`.

Wire `summary.ts`:

- read the ledger if present and add `evidenceSummary`.

Do not derive evidence by reparsing `session.jsonl` in v1.

## UI

Add compact summary section:

```text
Evidence
✓ T001 parser quality gate       tests: 3/3 · retry: 0 · src/...
⚠ T002 planner fallback          escalated · tests: 2/2 · src/...
✗ T003 snapshot restore          failed validation · src/...
```

Small terminal: status icon, task id, truncated title, final status.

No nested cards.

## Tests

Pure tests:

- ledger initializes from tasks,
- task completion records method/retry/duration,
- validation failure records stage and error summary,
- escalation is visible,
- optional fields preserve backward compatibility.

Component tests:

- summary evidence renders statuses,
- long titles truncate,
- small terminal variant fits.
- `buildSummary` includes `evidenceSummary` when `evidence.json` exists and omits it for old sessions.

## Acceptance Criteria

- Completed runs write `evidence.json`.
- Summary screen exposes evidence.
- Raw `session.jsonl` remains unchanged as debug source.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/evidence.test.ts
npm run typecheck
npm run lint
npm test
```
