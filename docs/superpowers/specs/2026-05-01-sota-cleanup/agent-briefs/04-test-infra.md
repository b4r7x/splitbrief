# 04 - Test Infrastructure (Faux Provider)

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Create a faux planner/implementer system for behavioral testing. Delete trivial tests. This provides the foundation for rewriting `vi.mock`-heavy tests in future work.

## Standard Project Constraints

- Node.js 22+, TypeScript ESM only; imports include `.js` suffixes.
- No classes. No barrel files.
- Tests must verify behavior, not implementation.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/engine/planners/types.ts` (the Planner interface — exact method signatures)
- `src/engine/implementers/types.ts` (the Implementer interface — exact method signatures)
- `testing/helpers/bus-recorder.ts` (bus recorder pattern)
- `testing/helpers/factories/config.ts` (config factory)
- `testing/helpers/factories/task.ts` (task factory)

## Write Ownership

```
testing/helpers/faux/planner.ts (new)
testing/helpers/faux/implementer.ts (new)
testing/helpers/faux/workflow.ts (new)
testing/helpers/faux/faux.test.ts (new)
src/core/tokens/estimate.test.ts (delete)
src/utils/type-guards.test.ts (delete)
```

## Tasks

### 4A: Delete trivial tests

```bash
rm src/core/tokens/estimate.test.ts
rm src/utils/type-guards.test.ts
```

Run `npm test` — must pass.

### 4B: Create faux planner

Create `testing/helpers/faux/planner.ts`.

First, read `src/engine/planners/types.ts` to get the exact `Planner` interface. The faux must implement ALL methods:
- `plan(feature, projectDir, callbacks, skillsContext?, codebaseContext?) → PlanResult`
- `quickPlan(feature, projectDir, callbacks, codebaseContext?) → PlanResult`
- `escalateHint(task, error, projectDir, callbacks) → EscalationResult`
- `escalateFull(task, error, projectDir, callbacks) → EscalationResult`
- `regenerate(prompt, artifactType, projectDir, callbacks) → RegenerateResult`
- `review(prompt, projectDir, callbacks) → { text, usage }`
- `capabilities: PlannerCapabilities`
- `dispose(): void`

Design:
- Accept `{ plans?: FauxPlanScript[], escalations?: FauxEscalationScript[] }` options
- `FauxPlanScript = { tasks: Task[], spec?: string, plan?: string, usage?: TokenDelta | null, throws?: Error }`
- `FauxEscalationScript = { success: boolean, output?: string, code?: string | null, usage?: TokenDelta | null, throws?: Error }`
- Cycle through scripts on repeated calls (modulo length)
- Track state: `planCallCount`, `quickPlanCallCount`, `escalateHintCallCount`, `escalateFullCallCount`, `receivedFeatures`, `receivedErrors`
- Export `fauxPlanner(opts?) → { planner: Planner, state: FauxPlannerState }`
- `regenerate` and `review` return empty defaults
- Set `capabilities` to `ONE_SHOT_API_CAPS` from planner types

### 4C: Create faux implementer

Create `testing/helpers/faux/implementer.ts`.

Read `src/engine/implementers/types.ts` for exact interface:
- `implement(opts: ImplementerOptions) → ImplementerResult`
- `retry(opts: RetryOptions) → ImplementerResult`
- `capabilities?: ImplementerCapabilities`
- `dispose(): void`

Design:
- Accept `{ steps?: FauxImplementStep[], retries?: FauxRetryStep[] }` options
- `FauxImplementStep = { success: boolean, output?: string, error?: string, usage?: TokenDelta, delayMs?: number, throws?: Error }`
- `FauxRetryStep = { success: boolean, output?: string, error?: string, usage?: TokenDelta, throws?: Error }`
- Cycle through scripts. Track state: `implementCallCount`, `retryCallCount`, `receivedTasks`, `receivedErrors`
- Export `fauxImplementer(opts?) → { implementer: Implementer, state: FauxImplementerState }`

### 4D: Create workflow harness + smoke test

Create `testing/helpers/faux/workflow.ts`:
- Composes `fauxPlanner` + `fauxImplementer` + `makeBusRecorder` + `makeConfig`
- Export `createFauxWorkflow(opts?) → { planner, implementer, plannerState, implementerState, events, eventsOfType, bus, config }`

Create `testing/helpers/faux/faux.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { fauxPlanner } from './planner.js';
import { fauxImplementer } from './implementer.js';
import { makeTask } from '../factories/task.js';

describe('fauxPlanner', () => {
  it('returns scripted tasks and tracks calls', async () => {
    const task = makeTask({ title: 'test task' });
    const { planner, state } = fauxPlanner({ plans: [{ tasks: [task] }] });
    const result = await planner.plan('add feature', '/tmp', { onOutput: () => {} });
    expect(result.tasks).toHaveLength(1);
    expect(state.planCallCount).toBe(1);
    expect(state.receivedFeatures).toEqual(['add feature']);
  });

  it('throws when script says so', async () => {
    const { planner } = fauxPlanner({ plans: [{ tasks: [], throws: new Error('boom') }] });
    await expect(planner.plan('x', '/tmp', { onOutput: () => {} })).rejects.toThrow('boom');
  });
});

describe('fauxImplementer', () => {
  it('returns scripted results and cycles', async () => {
    const { implementer, state } = fauxImplementer({
      steps: [
        { success: true, output: 'done' },
        { success: false, error: 'fail' },
      ],
    });
    // Need to construct minimal ImplementerOptions — read the type and provide required fields
    // task, projectDir, config, context, onOutput are required
    const opts = { task: makeTask(), projectDir: '/tmp', config: {} as any, context: {} as any, onOutput: () => {} };
    const r1 = await implementer.implement(opts as any);
    const r2 = await implementer.implement(opts as any);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(false);
    expect(state.implementCallCount).toBe(2);
  });
});
```

Note: Adapt the test to match actual factory signatures. Read `makeTask`, `makeConfig` to get correct call patterns. The test MUST compile and run.

## Verification

```bash
npx tsc --noEmit --project tsconfig.test.json
npx vitest run testing/helpers/faux/faux.test.ts
npm test
```

All must pass.
