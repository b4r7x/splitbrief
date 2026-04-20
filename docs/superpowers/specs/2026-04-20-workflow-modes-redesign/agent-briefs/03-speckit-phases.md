# Brief 03 — Speckit phases: constitution-check, clarifying, analyzing

> **You are a fresh AI context.** Read `../spec.md` §4.1.4 and §4.4 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Turn `speckit` from an alias of `standard` into a real spec-driven workflow: after spec is written, run a clarifying phase; before planning, run a constitution check; after planning, run an analyze phase.

## Dependencies

- Brief 01 complete (speckit is in `WORKFLOW_MODES`).
- Brief 02 complete OR in progress (new engine-event variant pattern is established).

## Files to touch

Write-authoritative:

- `src/core/schemas/enums.ts`
- `src/core/phases.ts`
- `src/core/state/machine.ts`
- `src/core/types/state-actions.ts`
- `src/core/schemas/analyze.ts` (NEW)
- `src/core/schemas/clarification.ts` (NEW; if not already present)
- `src/core/schemas/constitution.ts` (NEW)
- `src/engine/events/types.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/engine/orchestrator/planning/speckit.ts` (NEW)
- `src/engine/orchestrator/planning/speckit.test.ts` (NEW)
- `src/engine/spec/prompts/constitution.ts` (NEW)
- `src/engine/spec/prompts/clarify.ts` (NEW)
- `src/engine/spec/prompts/analyze.ts` (NEW)
- `src/engine/spec/prompts/{constitution,clarify,analyze}.test.ts` (NEW, three files)
- `src/engine/planners/types.ts`
- `src/engine/planners/base.ts`
- `src/core/paths.ts`
- `src/features/workflow/components/event-cards/event-card.tsx`
- `docs/WORKFLOW.md`

Read-only:

- `src/engine/orchestrator/planning/new.ts` (aka full-planning) — existing structural template for `speckit.ts`
- `.specify/memory/constitution.md` — to understand the constitution format

## Step-by-step

### 1. New phase enum entries

File: `src/core/schemas/enums.ts` (line 39 area)

Add three new phases to `PHASES`, placed in workflow order:

```ts
export const PHASES = [
  'idle',
  'researching',
  'specifying',
  'reviewing-spec',
  'clarifying',        // NEW — speckit only
  'constitution-check', // NEW — speckit only
  'planning',
  'reviewing-plan',
  'analyzing',         // NEW — speckit only
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
  'complete',
] as const;
```

### 2. Phase role taxonomy

File: `src/core/phases.ts`

Add to the existing sets:

```ts
export const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'reviewing-plan',
  'analyzing',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);
```

The three new phases are "planner" role (call `phaseRole`):

```ts
const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);
// All others including clarifying/constitution-check/analyzing → planner role.
// No change to phaseRole() needed — default branch handles it.
```

All three are cancellable (user can Ctrl-C out of them):

```ts
export const CANCELLABLE_PHASES: ReadonlySet<Phase> = new Set([
  'researching', 'specifying', 'reviewing-spec',
  'clarifying', 'constitution-check',
  'planning', 'reviewing-plan',
  'analyzing',
  'implementing', 'validating-task', 'escalating', 'final-review',
]);
```

### 3. New state actions

File: `src/core/types/state-actions.ts`

Add to the `StateAction` union:

```ts
| { type: 'SPEC_CLARIFY_DONE'; clarifications: Clarification[] }
| { type: 'CONSTITUTION_CHECK_PASS' }
| { type: 'CONSTITUTION_CHECK_FAIL'; reason: string }
| { type: 'ANALYZE_DONE'; analysis: AnalyzeResult }
```

Import `Clarification` and `AnalyzeResult` from the new schema files (step 4).

### 4. New schemas

File: `src/core/schemas/analyze.ts` (NEW)

```ts
import { z } from 'zod';
import { TaskIdSchema } from './task.js';

export const AnalyzeResultSchema = z.object({
  specTaskCoverage: z.number().min(0).max(1),
  planTaskCoverage: z.number().min(0).max(1),
  orphanTasks: z.array(TaskIdSchema),
  unaddressedSpecSections: z.array(z.string()),
  warnings: z.array(z.string()).default([]),
});
export type AnalyzeResult = z.infer<typeof AnalyzeResultSchema>;
```

File: `src/core/schemas/constitution.ts` (NEW)

```ts
import { z } from 'zod';

export const ConstitutionCheckResultSchema = z.object({
  passed: z.boolean(),
  violations: z.array(
    z.object({
      principle: z.string(),
      reason: z.string(),
      severity: z.enum(['hard', 'soft']),
    }),
  ),
});
export type ConstitutionCheckResult = z.infer<typeof ConstitutionCheckResultSchema>;
```

File: `src/core/schemas/clarification.ts`

If a clarification schema already exists in the project (grep `Clarification` — the existing workflow uses `<!-- Q:{...} -->` markers; search for where those are parsed), reuse it. Otherwise create:

```ts
import { z } from 'zod';

export const ClarificationSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  askedAt: z.number(),
  answeredAt: z.number(),
});
export type Clarification = z.infer<typeof ClarificationSchema>;
```

### 5. State machine handlers

File: `src/core/state/machine.ts`

Add clauses:

```ts
case 'SPEC_CLARIFY_DONE':
  return { ...state, phase: 'constitution-check', clarifications: action.clarifications };

case 'CONSTITUTION_CHECK_PASS':
  return { ...state, phase: 'planning' };

case 'CONSTITUTION_CHECK_FAIL':
  return {
    ...state,
    phase: 'idle',
    constitutionFailureReason: action.reason,
    completedAt: Date.now(),
  };

case 'ANALYZE_DONE':
  return { ...state, phase: 'implementing', analysisResult: action.analysis, currentTaskIndex: 0, attempt: 0 };
```

The `State` type needs three new optional fields:

```ts
clarifications?: Clarification[];
constitutionFailureReason?: string;
analysisResult?: AnalyzeResult;
```

### 6. Paths

File: `src/core/paths.ts`

Add:

```ts
export const CLARIFICATIONS_FILE = 'clarifications.md';
export const CONSTITUTION_CHECK_FILE = 'constitution-check.json';
export const ANALYZE_FILE = 'analyze.json';
```

### 7. Engine events

File: `src/engine/events/types.ts`

Add variants:

```ts
| { type: 'constitution_check_started'; phase: Phase; ts: number }
| { type: 'constitution_check_completed'; phase: Phase; ts: number; passed: boolean }
| { type: 'constitution_check_failed'; phase: Phase; ts: number; reason: string }
| { type: 'clarify_started'; phase: Phase; ts: number }
| { type: 'clarify_completed'; phase: Phase; ts: number; count: number }
| { type: 'analyze_started'; phase: Phase; ts: number }
| { type: 'analyze_completed'; phase: Phase; ts: number; specCoverage: number; planCoverage: number; orphanCount: number }
```

Add minimal renderers in `event-card.tsx` (one `<Text>` line each, use `theme.planner` for the normal events, `theme.error` for `constitution_check_failed`).

### 8. Planner prompts

File: `src/engine/spec/prompts/constitution.ts`

```ts
import { buildPrompt } from './shared.js';

/**
 * Ask the planner to check the proposed feature against the project's constitution.
 * Constitution content comes from `.specify/memory/constitution.md` if present.
 *
 * Expected output: strict JSON matching {@link ConstitutionCheckResultSchema}.
 */
export function buildConstitutionPrompt(
  feature: string,
  spec: string,
  constitutionContent: string,
): string {
  return buildPrompt({
    title: 'Constitution Check',
    instructions: [
      'You are given a feature spec and a project constitution.',
      'Identify any violations of constitutional principles.',
      'A violation is "hard" if it would require rewriting core architecture, "soft" if it is a style/convention issue.',
      'Output STRICT JSON with the shape: { passed: boolean, violations: [{ principle, reason, severity }] }.',
      'Do not include any prose outside the JSON block.',
    ],
    sections: [
      { heading: 'Constitution', body: constitutionContent || '(no constitution.md present)' },
      { heading: 'Feature', body: feature },
      { heading: 'Spec', body: spec },
    ],
    requiredOutputSections: ['JSON'],
  });
}
```

File: `src/engine/spec/prompts/clarify.ts`

```ts
import { buildPrompt } from './shared.js';

/**
 * Ask the planner to identify ambiguities in the spec and formulate up to N targeted questions.
 * Questions are returned inline via the existing `<!-- Q:{"id":"...","question":"..."} -->` markers.
 */
export function buildClarifyPrompt(spec: string, maxQuestions = 5): string {
  return buildPrompt({
    title: 'Spec Clarification',
    instructions: [
      `You are given a feature spec. Identify up to ${maxQuestions} ambiguities or underspecified requirements that, if left unresolved, would cause a small local implementer to make wrong assumptions.`,
      'For each, emit an inline marker: <!-- Q:{"id":"Q1","question":"..."} -->',
      'If the spec is sufficiently clear, emit zero markers and a single line: "No clarifications needed."',
      'Keep questions concrete and answerable with a short reply.',
    ],
    sections: [{ heading: 'Spec', body: spec }],
    requiredOutputSections: [],
  });
}
```

File: `src/engine/spec/prompts/analyze.ts`

```ts
import { buildPrompt } from './shared.js';

/**
 * Ask the planner to cross-check spec ↔ plan ↔ tasks.
 * Output: JSON matching {@link AnalyzeResultSchema}.
 */
export function buildAnalyzePrompt(
  spec: string,
  plan: string,
  tasks: string,
): string {
  return buildPrompt({
    title: 'Spec ↔ Plan ↔ Tasks Analysis',
    instructions: [
      'Compute coverage metrics across the three artifacts:',
      '  - specTaskCoverage: fraction of spec-requirements referenced by at least one task (0..1).',
      '  - planTaskCoverage: fraction of plan-steps referenced by at least one task (0..1).',
      '  - orphanTasks: task IDs with no corresponding spec or plan anchor.',
      '  - unaddressedSpecSections: spec section headings not covered by any task.',
      'Output STRICT JSON. No prose outside the JSON block.',
    ],
    sections: [
      { heading: 'Spec', body: spec },
      { heading: 'Plan', body: plan },
      { heading: 'Tasks', body: tasks },
    ],
    requiredOutputSections: ['JSON'],
  });
}
```

Tests: one file per prompt, each with three cases (happy-path content assertions, output-section requirement, variable substitution).

### 9. Planner interface extensions

File: `src/engine/planners/types.ts`

Add to `Planner`:

```ts
/** Speckit: constitution check. Optional; speckit falls back to passing-by-default if absent. */
checkConstitution?: (
  feature: string,
  spec: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
) => Promise<ConstitutionCheckResult>;

/** Speckit: spec clarification round. Returns structured Q&A collected. */
clarifySpec?: (
  spec: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
) => Promise<Clarification[]>;

/** Speckit: post-plan analysis. */
analyzeArtifacts?: (
  spec: string,
  plan: string,
  tasks: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
) => Promise<AnalyzeResult>;
```

### 10. Base planner implementations

File: `src/engine/planners/base.ts`

Add three helper functions that wrap `invokeEscalate` or the existing invocation pipe, following the `regenerate` pattern. Each parses the planner output into the strict schema:

```ts
async function invokeCheckConstitution(
  this: Planner,
  feature: string,
  spec: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
): Promise<ConstitutionCheckResult> {
  const constitutionPath = path.join(projectDir, '.specify', 'memory', 'constitution.md');
  const constitutionContent = (() => {
    try { return fs.readFileSync(constitutionPath, 'utf8'); }
    catch { return ''; }
  })();

  if (constitutionContent.trim() === '') {
    // No constitution → pass silently.
    return { passed: true, violations: [] };
  }

  const prompt = buildConstitutionPrompt(feature, spec, constitutionContent);
  const { text, usage } = await this.invokeEscalate(prompt, callbacks);
  this.accountUsage(usage, 'planner');

  const json = extractJsonBlock(text);
  const parsed = ConstitutionCheckResultSchema.safeParse(json);
  if (!parsed.success) {
    // Tolerant fallback: malformed planner output → warn, treat as pass.
    return {
      passed: true,
      violations: [{ principle: 'meta', reason: `constitution check output malformed: ${parsed.error.message}`, severity: 'soft' }],
    };
  }
  return parsed.data;
}

async function invokeClarifySpec(
  this: Planner,
  spec: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
): Promise<Clarification[]> {
  const prompt = buildClarifyPrompt(spec);
  const { text, usage } = await this.invokeEscalate(prompt, callbacks);
  this.accountUsage(usage, 'planner');

  // Parse inline <!-- Q:{...} --> markers using existing parser (reuse src/engine/parsers/questions.ts or similar).
  // Use the existing question parser: src/engine/parsers/question-parser.ts
  // Function: extractQuestionsFromStream(text) → ClarificationQuestion[]
  const questions = extractQuestionsFromStream(text);
  if (questions.length === 0) return [];

  // Hand the questions to the callback loop (existing onQuestion channel) so the user answers inline.
  const clarifications: Clarification[] = [];
  for (const q of questions) {
    const answer = await callbacks.onQuestion?.({ id: q.id, question: q.question });
    if (!answer) continue;
    clarifications.push({
      id: q.id,
      question: q.question,
      answer,
      askedAt: q.askedAt ?? Date.now(),
      answeredAt: Date.now(),
    });
  }
  return clarifications;
}

async function invokeAnalyzeArtifacts(
  this: Planner,
  spec: string,
  plan: string,
  tasks: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
): Promise<AnalyzeResult> {
  const prompt = buildAnalyzePrompt(spec, plan, tasks);
  const { text, usage } = await this.invokeEscalate(prompt, callbacks);
  this.accountUsage(usage, 'planner');

  const json = extractJsonBlock(text);
  const parsed = AnalyzeResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      specTaskCoverage: 0,
      planTaskCoverage: 0,
      orphanTasks: [],
      unaddressedSpecSections: [],
      warnings: [`analyze output malformed: ${parsed.error.message}`],
    };
  }
  return parsed.data;
}
```

Helper `extractJsonBlock(text)`: find the first `{ ... }` balanced block in the text, or the contents of a ``` ```json``` fenced block, whichever comes first. If neither is found, return `{}`.

Attach to planner similarly to other methods:

```ts
planner.checkConstitution = invokeCheckConstitution.bind(planner);
planner.clarifySpec = invokeClarifySpec.bind(planner);
planner.analyzeArtifacts = invokeAnalyzeArtifacts.bind(planner);
```

### 11. `runSpeckitPlanning`

File: `src/engine/orchestrator/planning/speckit.ts` (NEW)

Full flow:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runNewPlanning, type NewPlanningResult } from './new.js';
import { publishPlannerStatus } from '../events.js';
import { transitionAndSave } from '../../../core/state/persistence.js';
import { ANALYZE_FILE, CLARIFICATIONS_FILE, CONSTITUTION_CHECK_FILE, sessionDir } from '../../../core/paths.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

export async function runSpeckitPlanning(
  opts: PlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, state, planner, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);

  // 1. Run the existing full-planning up through spec approval.
  //    We need to intervene AFTER spec approval but BEFORE planning.
  //    Modify runNewPlanning to accept a hook, or duplicate its spec-phase logic here.
  //    Path chosen: duplicate, because runNewPlanning is stable and invasive changes risk regression.
  const specResult = await runSpecPhaseOnly(opts);
  if (specResult.rejected) return { state: specResult.state, tasks: [] };

  // 2. Clarify.
  bus.publish({ type: 'clarify_started', phase: 'clarifying', ts: Date.now() });
  const clarifications = planner.clarifySpec
    ? await planner.clarifySpec(specResult.spec, projectDir, opts.callbacks.plannerCallbacks)
    : [];
  writeFileSync(path.join(dir, CLARIFICATIONS_FILE), formatClarifications(clarifications), 'utf8');
  bus.publish({ type: 'clarify_completed', phase: 'clarifying', ts: Date.now(), count: clarifications.length });

  const state1 = transitionAndSave(projectDir, sessionId, specResult.state, { type: 'SPEC_CLARIFY_DONE', clarifications });

  // 3. Constitution check.
  bus.publish({ type: 'constitution_check_started', phase: 'constitution-check', ts: Date.now() });
  const constitutionResult = planner.checkConstitution
    ? await planner.checkConstitution(opts.feature, specResult.spec, projectDir, { onOutput: opts.callbacks.onPlannerOutput ?? (() => undefined) })
    : { passed: true as const, violations: [] };

  writeFileSync(
    path.join(dir, CONSTITUTION_CHECK_FILE),
    JSON.stringify(constitutionResult, null, 2),
    'utf8',
  );

  const hardViolation = constitutionResult.violations.find(v => v.severity === 'hard');
  if (hardViolation || !constitutionResult.passed) {
    bus.publish({
      type: 'constitution_check_failed',
      phase: 'constitution-check',
      ts: Date.now(),
      reason: hardViolation?.reason ?? 'constitution check failed',
    });
    const failed = transitionAndSave(projectDir, sessionId, state1, {
      type: 'CONSTITUTION_CHECK_FAIL',
      reason: hardViolation?.reason ?? 'constitution check failed',
    });
    return { state: failed, tasks: [] };
  }
  bus.publish({ type: 'constitution_check_completed', phase: 'constitution-check', ts: Date.now(), passed: true });

  let state2 = transitionAndSave(projectDir, sessionId, state1, { type: 'CONSTITUTION_CHECK_PASS' });

  // 4. Plan + tasks via the existing pipeline.
  const planResult = await runPlanTasksOnly(opts, state2, specResult.spec);
  if (planResult.rejected) return { state: planResult.state, tasks: [] };

  // 5. Analyze.
  bus.publish({ type: 'analyze_started', phase: 'analyzing', ts: Date.now() });
  const analysis = planner.analyzeArtifacts
    ? await planner.analyzeArtifacts(specResult.spec, planResult.plan, planResult.tasksText, projectDir, { onOutput: opts.callbacks.onPlannerOutput ?? (() => undefined) })
    : { specTaskCoverage: 1, planTaskCoverage: 1, orphanTasks: [], unaddressedSpecSections: [], warnings: [] };

  writeFileSync(
    path.join(dir, ANALYZE_FILE),
    JSON.stringify(analysis, null, 2),
    'utf8',
  );

  bus.publish({
    type: 'analyze_completed',
    phase: 'analyzing',
    ts: Date.now(),
    specCoverage: analysis.specTaskCoverage,
    planCoverage: analysis.planTaskCoverage,
    orphanCount: analysis.orphanTasks.length,
  });

  const minCoverage = wctx.config.workflow.speckit?.minCoverage ?? 0.9;
  if (analysis.specTaskCoverage < minCoverage || analysis.planTaskCoverage < minCoverage) {
    bus.publish({
      type: 'warning',
      phase: 'analyzing',
      ts: Date.now(),
      message: `analysis coverage below threshold (${minCoverage}): spec=${analysis.specTaskCoverage}, plan=${analysis.planTaskCoverage}`,
    });
  }

  const finalState = transitionAndSave(projectDir, sessionId, planResult.state, { type: 'ANALYZE_DONE', analysis });
  return { state: finalState, tasks: planResult.tasks };
}

function formatClarifications(items: Clarification[]): string {
  if (items.length === 0) return '# Clarifications\n\n_No clarifications needed._\n';
  const lines = ['# Clarifications', ''];
  for (const c of items) {
    lines.push(`## ${c.id}: ${c.question}`);
    lines.push('');
    lines.push(c.answer);
    lines.push('');
  }
  return lines.join('\n');
}
```

`runSpecPhaseOnly` and `runPlanTasksOnly` are helpers to extract from the existing `runFullPlanning` / `runNewPlanning`. Rather than duplicate, refactor `new.ts` to expose these two sub-phases as individual exported functions:

```ts
// in new.ts:
export async function runSpecPhaseOnly(opts: PlanningPhaseOptions): Promise<{ state: State; spec: string; rejected: boolean }> { /* ... */ }
export async function runPlanTasksOnly(opts: PlanningPhaseOptions, state: State, spec: string): Promise<{ state: State; plan: string; tasksText: string; tasks: Task[]; rejected: boolean }> { /* ... */ }

// The existing runFullPlanning / runNewPlanning now composes these:
export async function runNewPlanning(opts: PlanningPhaseOptions, skipPlanApproval: boolean): Promise<PlanningPhaseResult> {
  const spec = await runSpecPhaseOnly(opts);
  if (spec.rejected) return { state: spec.state, tasks: [] };
  const plan = await runPlanTasksOnly(opts, spec.state, spec.spec);
  return { state: plan.state, tasks: plan.tasks };
}
```

This refactor must not change existing behaviour — validate with existing `new.test.ts` tests.

### 12. Wire into the dispatcher

File: `src/engine/orchestrator/planning/run.ts`

Before (after brief 02):

```ts
// standard + speckit both use runFullPlanning for now.
// Brief 03 will split speckit into its own function.
const skipPlanApproval = mode === 'standard';
return runFullPlanning(optsWithContext, skipPlanApproval);
```

After:

```ts
if (mode === 'speckit') {
  return runSpeckitPlanning(optsWithContext);
}
// standard
const skipPlanApproval = true;
return runFullPlanning(optsWithContext, skipPlanApproval);
```

(Note: `skipPlanApproval` for `standard` is now always true; brief 04 will flip this to read from `workflow.approve`.)

### 13. Artifact type contract

The resulting session folder for a speckit run:

```
.diptych/sessions/<id>/
├── research.md
├── spec.md
├── clarifications.md           (NEW)
├── constitution-check.json     (NEW)
├── plan.md
├── tasks.md
├── analyze.json                (NEW)
├── session.jsonl
├── state.json
├── summary.json
└── (any review.md written later)
```

Document in `docs/WORKFLOW.md` §1.4 (Persistence timing table).

### 14. Tests

`src/engine/orchestrator/planning/speckit.test.ts` — use mock planner; assert phase transitions, events published, artifacts written.

`src/engine/planners/base.test.ts` — for the three new base methods, mock `invokeEscalate`, assert correct prompt built, output parsed.

`src/core/state/machine.test.ts` — for each new action, assert correct transition:
- `SPEC_CLARIFY_DONE` from `reviewing-spec` → `constitution-check` (note: action name `SPEC_CLARIFY_DONE` is chosen to avoid collision with the existing `CLARIFICATION_ANSWERED` if it exists — check and rename if needed).
- `CONSTITUTION_CHECK_PASS` from `constitution-check` → `planning`.
- `CONSTITUTION_CHECK_FAIL` from `constitution-check` → `idle`.
- `ANALYZE_DONE` from `analyzing` → `implementing`.

### 15. Doc updates

File: `docs/WORKFLOW.md`

Extend §1.1 phase-transition table with the four new rows.

Add §1.3.2 "A speckit run, step by step" describing the full 7-phase flow.

Extend §1.4 persistence table with `clarifications.md`, `constitution-check.json`, `analyze.json`.

### 16. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Checkpoint

After this brief:

- `diptych start --mode speckit "x"` runs through seven phases.
- Three new artifacts land on disk.
- `constitution_check_failed` terminates the workflow with `idle` phase and failure reason.
- Coverage warnings are advisory, not blocking.

## Rollback

Brief 03 is the largest change-set. Rolling back is non-trivial — the state-action union change cascades into dozens of tests. Prefer forward-fix to rollback. If rollback is unavoidable: revert all listed files, delete all NEW files, restore the state machine's `State` type, restore `planning/run.ts` to brief-02 state (the `if (mode === 'speckit') return runFullPlanning(...)` fallback).
