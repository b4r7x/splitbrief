# Brief 02 — Implement `instant` mode

> **You are a fresh AI context.** Read `../spec.md` §4.1.1 and `../spec.md` §4.4 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Implement the `instant` mode planner path: one planner call, minimal artifacts (`tasks.md` + `session.jsonl` + `summary.json`), no approval gates, transitions directly to the task loop.

## Dependencies

- Brief 01 complete (`instant` is in `WORKFLOW_MODES`, v3 config schema exists, `resolveMode` helper exists).

## Files to touch

Write-authoritative:

- `src/engine/orchestrator/planning/run.ts`
- `src/engine/orchestrator/planning/instant.ts` (NEW)
- `src/engine/orchestrator/planning/instant.test.ts` (NEW)
- `src/engine/spec/prompts/instant.ts` (NEW)
- `src/engine/spec/prompts/instant.test.ts` (NEW)
- `src/engine/planners/types.ts`
- `src/engine/planners/base.ts`
- `src/core/state/machine.ts`
- `src/core/types/state-actions.ts`
- `src/engine/events/types.ts`
- `docs/WORKFLOW.md`

Read-only for reference:

- `src/engine/orchestrator/planning/quick.ts` — the structural template for `instant.ts`
- `src/engine/spec/prompts/quick-plan.ts` — the structural template for `instant.ts` prompt
- `src/engine/planners/base.ts:127-163` — current `quickPlan` implementation

## Step-by-step

### 1. Add state action + transition

File: `src/core/types/state-actions.ts`

Add a new variant to the `StateAction` union:

```ts
| { type: 'START_INSTANT'; tasks: Task[] }
```

Place it immediately after `START_QUICK` for readability.

File: `src/core/state/machine.ts`

Add the handler clause alongside `START_QUICK`:

```ts
case 'START_INSTANT':
  return {
    ...state,
    phase: 'implementing',
    tasks: action.tasks,
    currentTaskIndex: 0,
    attempt: 0,
    mode: 'instant',
  };
```

Verify `state.mode` exists on `State`. If it doesn't (check `src/core/schemas/state.ts` or wherever `State` is defined), add it as an optional `WorkflowMode` field and populate it in the existing `START` and `START_QUICK` handlers too. This field drives the event telemetry; do not wire it into gate-skipping logic.

### 2. Add engine events

File: `src/engine/events/types.ts`

Add two new variants to the `EngineEvent` discriminated union:

```ts
| { type: 'mode_resolved'; phase: Phase; ts: number; mode: WorkflowMode; approve: ApproveLevel; effort?: EffortLevel }
| { type: 'instant_plan_received'; phase: Phase; ts: number; taskCount: number }
```

Types `ApproveLevel` and `EffortLevel` will be introduced by briefs 04 and 05. For this brief, declare them locally as `string` if not yet imported:

```ts
// Placeholder until brief 04 / 05 land; these briefs will tighten the types.
export type ApproveLevel = 'spec' | 'plan' | 'none' | 'all' | 'default';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';
```

Export them from `src/core/schemas/enums.ts` if that is the project convention (check where `WorkflowMode` is exported from and colocate). Briefs 04 / 05 will pick them up from there.

### 3. Add renderer for new events

File: `src/features/workflow/components/event-cards/event-card.tsx`

Add two cases to the existing switch/map. Both are log-only (no rich card).

```tsx
case 'mode_resolved':
  return (
    <Text color={theme.muted}>
      mode: {event.mode} · approve: {event.approve}
      {event.effort ? ` · effort: ${event.effort}` : ''}
    </Text>
  );
case 'instant_plan_received':
  return <Text color={theme.muted}>instant: {event.taskCount} tasks</Text>;
```

### 4. Write the instant prompt

File: `src/engine/spec/prompts/instant.ts`

```ts
import { buildPrompt } from './shared.js';

/**
 * Build the prompt for {@link WorkflowMode} `instant`.
 *
 * Single-call prompt that asks the planner to emit ONLY a `## Tasks` section.
 * Unlike `quick`, no spec/plan sections are requested. Intended for trivial
 * changes where the planner can one-shot a 1-5 task breakdown.
 *
 * The returned prompt is identical to the `quick` prompt except that:
 *   - the instruction explicitly says "do not emit a spec or plan section"
 *   - the output-spec tolerates 1 task (quick-plan generally expects ≥2)
 */
export function buildInstantPrompt(
  feature: string,
  projectContext: string,
  skillsContext?: string,
): string {
  return buildPrompt({
    title: 'Instant Task Breakdown',
    instructions: [
      'You are given a tiny feature request. Emit a minimal task breakdown.',
      'Do NOT emit a spec or plan section — the requester has already decided this change is trivial.',
      'A single task is fine. Do not over-engineer.',
      'Each task MUST be self-contained so a small local model can implement it without additional context.',
    ],
    sections: [
      { heading: 'Feature', body: feature },
      { heading: 'Project context', body: projectContext },
      ...(skillsContext ? [{ heading: 'Skills', body: skillsContext }] : []),
    ],
    requiredOutputSections: ['Tasks'],
  });
}
```

(If `buildPrompt` has a different signature in the codebase, adapt. The test below pins the key assertions.)

File: `src/engine/spec/prompts/instant.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildInstantPrompt } from './instant.js';

describe('buildInstantPrompt', () => {
  it('requests only a Tasks section', () => {
    const prompt = buildInstantPrompt('rename foo to bar', 'repo-map: small');
    expect(prompt).toMatch(/## Tasks/i);
    expect(prompt).not.toMatch(/## Spec\b/i);
    expect(prompt).not.toMatch(/## Plan\b/i);
  });
  it('mentions trivial / small model constraint', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt.toLowerCase()).toContain('small');
  });
  it('includes skills when provided', () => {
    const prompt = buildInstantPrompt('x', 'y', 'skill: foo');
    expect(prompt).toMatch(/skill: foo/);
  });
  it('omits skills section when not provided', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).not.toMatch(/## Skills/i);
  });
});
```

### 5. Extend the Planner interface

File: `src/engine/planners/types.ts`

Add a new optional method to the `Planner` interface, mirroring `quickPlan`:

```ts
/**
 * Like {@link Planner.quickPlan} but for the `instant` mode.
 * Differences from `quickPlan`:
 *   - uses {@link buildInstantPrompt}
 *   - only `tasks.md` is persisted (no spec/plan/research)
 *   - the result's `spec` / `plan` / `phases` entries are empty strings / empty array
 *
 * Optional: backends that don't implement it fall back to `quickPlan ?? plan`
 * via the dispatcher in `instant.ts`.
 */
instantPlan?: (
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext?: string,
) => Promise<PlanResult>;
```

### 6. Implement `instantPlan` in the base

File: `src/engine/planners/base.ts`

Structurally mirror `quickPlan` at lines 127-163. Add a new function right after it:

```ts
async function invokeInstantPlan(
  this: Planner,
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext?: string,
): Promise<PlanResult> {
  const prompt = buildInstantPrompt(feature, codebaseContext ?? '');

  const { text, usage } = await this.invokePlan(prompt, callbacks);
  this.accountUsage(usage, 'planner');

  const tasks = parseTasks(text);

  return {
    spec: '',
    plan: '',
    tasks,
    phases: [
      { text, filename: TASKS_FILE },
    ],
  };
}
```

Attach it to the assembled planner factory similarly to how `quickPlan` is attached (find the section that does `planner.quickPlan = invokeQuickPlan.bind(planner)` and add an identical line for `instantPlan`).

If the base planner is constructed by composition rather than method binding (inspect the existing code — the explore-report showed it uses function-in-function composition), match the existing pattern exactly. Do not rewrite the composition pattern.

### 7. Write `runInstantPlanning`

File: `src/engine/orchestrator/planning/instant.ts` (NEW)

Template: mirror `src/engine/orchestrator/planning/quick.ts` but:

- call `planner.instantPlan ?? planner.quickPlan ?? planner.plan`
- do NOT write `spec.md`, `plan.md`, or `research.md`
- write ONLY `tasks.md`
- dispatch `START_INSTANT` instead of `START_QUICK`
- publish `instant_plan_received` event after the planner call returns

```ts
import { readFileSync } from 'node:fs';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { parseTasks } from '../../spec/parser.js';
import { persistPhases } from './persist.js';
import { publishPlannerStatus } from '../events.js';
import { transitionAndSave } from '../../../core/state/persistence.js';
import { TASKS_FILE } from '../../../core/paths.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

export async function runInstantPlanning(
  opts: PlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
  const { wctx, feature } = opts;
  const { projectDir, config, sessionId, state, planner, callbacks, bus } = wctx;

  publishPlannerStatus(bus, state.phase, 'instant planner call starting');

  const plannerCallbacks = {
    onOutput: opts.callbacks.onPlannerOutput ?? (() => undefined),
    onSessionId: (id: string) => {
      transitionAndSave(projectDir, sessionId, state, {
        type: 'SET_PLANNER_SESSION_ID',
        sessionId: id,
      });
    },
    sessionId: state.plannerSessionId,
    persistTranscript: config.workflow.persistTranscript,
  };

  const instantFn =
    planner.instantPlan ?? planner.quickPlan ?? planner.plan;
  const result = await instantFn.call(
    planner,
    feature,
    projectDir,
    plannerCallbacks,
    opts.codebaseContext,
  );

  persistPhases(projectDir, sessionId, result.phases);

  const tasks = result.tasks.length > 0 ? result.tasks : parseTasks(result.phases[0]?.text ?? '');

  if (tasks.length === 0) {
    throw new Error('instant planner returned zero tasks; cannot proceed');
  }

  bus.publish({
    type: 'instant_plan_received',
    phase: state.phase,
    ts: Date.now(),
    taskCount: tasks.length,
  });

  const nextState = transitionAndSave(projectDir, sessionId, state, {
    type: 'START_INSTANT',
    tasks,
  });

  return { state: nextState, tasks };
}
```

Colocated test file `src/engine/orchestrator/planning/instant.test.ts` — mock planner with `instantPlan` returning a `PlanResult`, assert `START_INSTANT` dispatched, assert `tasks.md` written, assert `instant_plan_received` published. Use existing test helpers in the codebase (grep for `createTestWorkflowContext` or similar).

### 8. Wire into the dispatcher

File: `src/engine/orchestrator/planning/run.ts:9-31`

Before:

```ts
if (mode === 'instant') {
  throw new Error('instant mode requires brief 02 to be landed');
}
if (mode === 'quick') {
  return runQuickPlanning(optsWithContext);
}
const skipPlanApproval = mode === 'standard';
return runFullPlanning(optsWithContext, skipPlanApproval);
```

After:

```ts
if (mode === 'instant') {
  return runInstantPlanning(optsWithContext);
}
if (mode === 'quick') {
  return runQuickPlanning(optsWithContext);
}
// standard + speckit both use runFullPlanning for now.
// Brief 03 will split speckit into its own function.
const skipPlanApproval = mode === 'standard';
return runFullPlanning(optsWithContext, skipPlanApproval);
```

Also, publish the `mode_resolved` event at the top of `runPlanningPhase` (first line after resolving `mode`):

```ts
bus.publish({
  type: 'mode_resolved',
  phase: state.phase,
  ts: Date.now(),
  mode,
  approve: 'default', // brief 04 will replace with resolveApproveLevel()
});
```

### 9. Guard rails around artifact writes in instant mode

Search for every place that writes `spec.md`, `plan.md`, or `research.md` (grep `writeSpecFile`, `writePlanFile`, etc. — see explore-report §6):

For each write point, verify that it is called only from paths that are NOT `runInstantPlanning`. Since we built `runInstantPlanning` to not call those functions, this should already be correct. Add an assertion at the top of each write function as defence-in-depth:

```ts
// in writeSpecFile, writePlanFile, writeResearchFile (wherever they live):
if (mode === 'instant') {
  throw new Error(`assertion: ${filename} must not be written in instant mode`);
}
```

(If these functions don't receive `mode`, skip the assertion — the test coverage below validates the behaviour instead.)

### 10. Task loop invariants

File: `src/engine/orchestrator/task-loop.ts`

The existing task loop reads `state.tasks` and iterates. No changes needed — `instant` mode populates `state.tasks` via `START_INSTANT` just as `quick` populates via `START_QUICK`. The escalation path, validation pipeline, and git commit logic all apply unchanged.

### 11. Tests — integration

File: `src/engine/orchestrator/run/run.integration.test.ts` (or create if missing)

Add a test case:

```ts
describe('runWorkflow instant mode', () => {
  it('completes with only tasks.md + session.jsonl + summary.json on disk', async () => {
    const ctx = createTestWorkflowContext({
      mode: 'instant',
      feature: 'rename foo to bar',
      plannerResult: {
        spec: '',
        plan: '',
        tasks: [{ id: 'T001', title: 'rename', file: 'src/foo.ts', action: 'modify', acceptanceCriteria: [] }],
        phases: [{ text: '## Tasks\n- rename', filename: 'tasks.md' }],
      },
    });

    await runWorkflow(ctx);

    const sessionDir = ctx.sessionDir;
    expect(existsSync(join(sessionDir, 'tasks.md'))).toBe(true);
    expect(existsSync(join(sessionDir, 'spec.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'plan.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'research.md'))).toBe(false);
    expect(existsSync(join(sessionDir, 'session.jsonl'))).toBe(true);
    expect(existsSync(join(sessionDir, 'summary.json'))).toBe(true);
  });

  it('does not invoke onApprovalNeeded', async () => {
    const onApprovalNeeded = vi.fn();
    const ctx = createTestWorkflowContext({ mode: 'instant', onApprovalNeeded });
    await runWorkflow(ctx);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });
});
```

Use the existing test harness patterns.

### 12. Doc updates

File: `docs/WORKFLOW.md`

Find §1.1 (phase-transition table). Add a row near the top:

```md
| `idle` | `START_INSTANT` | `implementing` | `--mode instant`; tasks provided directly, no spec/plan/research artifacts |
```

Find §1.3 (normal run, step by step) and add a subsection 1.3.1 for the instant flow:

```md
### 1.3.1 An instant run, step by step

`diptych start --mode instant "rename foo to bar"` follows the same bootstrap as a normal run up to `runWorkflow()`, then takes the `runInstantPlanning` path:

1. Single `planner.instantPlan()` (or falls back to `planner.quickPlan` / `planner.plan`).
2. Parse `tasks.md` from the response.
3. Dispatch `START_INSTANT` with the tasks.
4. Task loop runs identically to other modes (per-task validation, retry, escalation, git commit per `workflow.git.commitStrategy`).
5. Final review is skipped (no spec to review against). Workflow transitions directly `implementing → complete` after `ALL_DONE`.

Persisted artifacts: `tasks.md`, `session.jsonl`, `summary.json`. No `spec.md`, `plan.md`, or `research.md`.
```

### 13. Run verification

```bash
npm run typecheck
npm run lint
npm test
```

## Checkpoint

After this brief:

- `diptych start --mode instant "x"` runs end-to-end.
- Artifacts are exactly `tasks.md` + `session.jsonl` + `summary.json`.
- No approval gates.
- Integration test covers the above.
- `speckit` still runs through `runFullPlanning` (brief 03 rewires it).
- `--approve` flag does not exist yet (brief 04).

## Rollback

Revert the listed files and delete the NEW files. Brief 01 still holds because the guard `if (mode === 'instant') throw` in `runPlanningPhase` has been replaced by `return runInstantPlanning(optsWithContext)` — to revert this brief cleanly you also need to restore that guard.
