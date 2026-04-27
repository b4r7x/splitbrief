# 01 — Task Brief Quality Gate

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add a deterministic quality gate for Task Briefs after `tasks.md` is parsed and before implementation starts.

The gate must catch:

- missing validation,
- vague validation,
- missing implementation steps,
- risky tasks with no escalation rules,
- modify tasks with no usable code context,
- multi-file tasks disguised as one task,
- missing evidence/scope as warnings.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/core/schemas/task.ts`
- `src/engine/spec/parser.ts`
- `src/engine/spec/prompts/tasks.ts`
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/orchestrator/planning/instant.ts`
- `src/engine/orchestrator/planning/quick.ts`
- `src/engine/orchestrator/planning/new.ts`
- `src/engine/orchestrator/planning/speckit.ts`

## Files To Touch

- `src/core/paths.ts`
- `src/engine/spec/brief-quality.ts` new
- `src/engine/spec/brief-quality.test.ts` new
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/orchestrator/planning/instant.ts`
- `src/engine/orchestrator/planning/quick.ts`
- `src/engine/orchestrator/planning/new.ts`
- `src/engine/orchestrator/planning/speckit.ts`
- `src/engine/events/types.ts`
- `docs/TASK-CONTRACT.md`
- `docs/WORKFLOW.md`

Do not touch implementers or provider code.

## Contract

Create these exact exports in `src/engine/spec/brief-quality.ts`:

```ts
export type BriefQualitySeverity = 'error' | 'warning';

export type BriefQualityIssue = {
  taskId: TaskId;
  severity: BriefQualitySeverity;
  code:
    | 'missing_scope'
    | 'missing_validation'
    | 'vague_validation'
    | 'missing_evidence'
    | 'missing_escalation'
    | 'missing_code_context'
    | 'empty_task_list'
    | 'multi_file_task'
    | 'non_atomic_task'
    | 'missing_implementation_steps';
  message: string;
};

export type BriefQualityReport = {
  version: 1;
  passed: boolean;
  score: number;
  issues: BriefQualityIssue[];
};

export function evaluateBriefQuality(tasks: Task[]): BriefQualityReport;
```

Do not add Task schema fields for this report.

## Rules

Errors block implementation:

- `tasks.length === 0`
- `tests.length === 0`
- all tests are vague, such as "works", "works correctly", "validate", "make sure it works"
- `implementationSteps.length === 0`
- description/steps mention changing multiple files while `task.file` is one file
- `action === 'modify'` and there is no `currentCode`, `signature`, or `pattern`
- risky task lacks `escalation`

`multi_file_task` means the brief names 2+ distinct project-relative file paths in prose, bullets, code fences, or examples, such as `src/a.ts` and `src/b.ts`. Repeating the same path in multiple places does not count.

Risk words:

- auth, security, secret, token, payment, database, migration, config, git, hook, permission, public API.

Warnings do not block:

- missing `scope`
- missing `evidence`
- missing `typeDefs` for a simple task

Score:

- start at `1`
- subtract `0.2` per error
- subtract `0.05` per warning
- clamp to `0..1`

## Persistence

Add `BRIEF_QUALITY_FILE = 'brief-quality.json'` to `src/core/paths.ts`.

Write:

```text
.diptych/sessions/<id>/brief-quality.json
```

Persist on pass and fail using a helper in `planning/shared.ts`:

```ts
export function runBriefQualityGate(...): { report: BriefQualityReport; ok: boolean };
```

The helper must:

1. call `evaluateBriefQuality(tasks)`,
2. write `brief-quality.json` under the session directory,
3. publish one of the events below,
4. return whether planning may continue.

## Events

Add dedicated event variants:

```ts
| {
    type: 'brief_quality_passed';
    ts: number;
    phase: Phase;
    score: number;
    warningCount: number;
  }
| {
    type: 'brief_quality_failed';
    ts: number;
    phase: Phase;
    score: number;
    errorCount: number;
    warningCount: number;
  }
```

Generic `warning`/`error` events may still accompany the dedicated event, but they do not replace it.

## Failure Behavior

If report has errors:

- publish concise error/warning event,
- persist the report,
- do not transition to `implementing`,
- return a clear planning failure message.

Do not invent a complex regeneration loop in this brief.

## Integration Points

Call `runBriefQualityGate` after `persistPhases(...)` and before these transitions:

- `START_INSTANT` in `planning/instant.ts`
- `START_QUICK` in `planning/quick.ts`
- `PLAN_DONE` / `APPROVE_PLAN` path in `planning/new.ts`
- `ANALYZE_DONE` / implementation entry path in `planning/speckit.ts`

If the gate fails, return `handlePlanningFailure(new Error(...))` from the planning path. The error message must include the first error code and task id.

## Tests

Add pure tests:

- valid brief passes with score `1`
- missing tests blocks
- vague tests block
- risky task without escalation blocks
- missing evidence warns but passes
- modify task without code context blocks
- multi-file wording blocks
- score clamps
- `runBriefQualityGate` writes the JSON report and publishes pass/fail event
- invalid report prevents a planning path from entering `implementing`
- empty task lists fail with `empty_task_list`, so parser failures cannot silently produce a successful run
- mode coverage for `instant`, `quick`, `standard`, and `speckit`

Add a focused planning helper test if the integration point is isolated. Assert state/artifacts/events, not helper calls.

## Acceptance Criteria

- Weak briefs fail before implementation.
- `brief-quality.json` is persisted.
- Older `Task` schema consumers are not broken.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/spec/brief-quality.test.ts src/engine/spec/parser.test.ts
npm run typecheck
npm run lint
npm test
```
