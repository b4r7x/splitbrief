# SOTA 06: Faux Provider Test Architecture

> **For agentic workers:** Execute task-by-task. After ALL tasks: run `npm run test-ci`.

**Goal:** Create a faux planner/implementer system for behavioral tests — scripted responses without subprocess/network. This replaces `vi.mock` + `vi.fn().mockResolvedValue()` patterns.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

**Context:** Currently, orchestrator tests mock the `Planner`/`Implementer` interfaces with `vi.fn()`. This creates implementation coupling. The SOTA approach (inspired by pi-mono's test harness) is to provide declarative scripted responses at the interface level.

---

### Task 1: Create `testing/helpers/faux/planner.ts`

**Files:**
- Create: `testing/helpers/faux/planner.ts`

**IMPORTANT:** The real `Planner` interface (from `src/engine/planners/types.ts`) has these exact signatures:
```typescript
interface Planner extends RunnerRuntime {
  plan(feature: string, projectDir: string, callbacks: PlannerCallbacks, skillsContext?: string, codebaseContext?: string): Promise<PlanResult>;
  quickPlan(feature: string, projectDir: string, callbacks: PlannerCallbacks, codebaseContext?: string): Promise<PlanResult>;
  escalateHint(task: Task, error: string, projectDir: string, callbacks: { onOutput: (text: string) => void }): Promise<EscalationResult>;
  escalateFull(task: Task, error: string, projectDir: string, callbacks: { onOutput: (text: string) => void }): Promise<EscalationResult>;
  regenerate(prompt: string, artifactType: 'spec'|'plan', projectDir: string, callbacks: { onOutput: (text: string) => void }): Promise<RegenerateResult>;
  review(prompt: string, projectDir: string, callbacks: { onOutput: (text: string) => void }): Promise<{ text: string; usage: TokenDelta | null }>;
}
```

The real `Implementer` interface:
```typescript
interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
  capabilities?: ImplementerCapabilities | undefined;
}
// ImplementerOptions = { task: Task; projectDir: string; config: Config; context: ProjectContext; onOutput: (text: string) => void; sessionId?; signal?; continuationPrompt?; bus?; phase?; approveWrite? }
// RetryOptions extends ImplementerOptions with { error: string; attempt: number; kind: 'local' | 'hint' }
```

- [ ] **Step 1: Create directory**

```bash
mkdir -p testing/helpers/faux
```

- [ ] **Step 2: Write the faux planner**

Create `testing/helpers/faux/planner.ts`:

```typescript
import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type { Planner, PlanResult, EscalationResult, PlannerCallbacks } from '../../../src/engine/planners/types.js';

export interface FauxPlanScript {
  tasks: Task[];
  spec?: string;
  plan?: string;
  usage?: TokenDelta | null;
  throws?: Error;
}

export interface FauxEscalationScript {
  success: boolean;
  output?: string;
  code?: string | null;
  usage?: TokenDelta | null;
  throws?: Error;
}

export interface FauxPlannerOptions {
  plans?: FauxPlanScript[];
  escalations?: FauxEscalationScript[];
}

export interface FauxPlannerState {
  planCallCount: number;
  quickPlanCallCount: number;
  escalateHintCallCount: number;
  escalateFullCallCount: number;
  receivedFeatures: string[];
  receivedErrors: string[];
}

export function fauxPlanner(opts: FauxPlannerOptions = {}): { planner: Planner; state: FauxPlannerState } {
  const plans = opts.plans ?? [];
  const escalations = opts.escalations ?? [];

  const state: FauxPlannerState = {
    planCallCount: 0,
    quickPlanCallCount: 0,
    escalateHintCallCount: 0,
    escalateFullCallCount: 0,
    receivedFeatures: [],
    receivedErrors: [],
  };

  function getNextPlan(): FauxPlanScript {
    const script = plans[state.planCallCount % Math.max(1, plans.length)];
    if (!script) throw new Error('fauxPlanner: no plan script configured');
    return script;
  }

  function getNextEscalation(): FauxEscalationScript {
    const idx = (state.escalateHintCallCount + state.escalateFullCallCount - 1) % Math.max(1, escalations.length);
    const script = escalations[idx];
    if (!script) throw new Error('fauxPlanner: no escalation script configured');
    return script;
  }

  const planner: Planner = {
    plan: async (feature: string, _projectDir: string, _callbacks: PlannerCallbacks): Promise<PlanResult> => {
      state.receivedFeatures.push(feature);
      const script = getNextPlan();
      state.planCallCount++;
      if (script.throws) throw script.throws;
      return { tasks: script.tasks, spec: script.spec ?? '', plan: script.plan ?? '', usage: script.usage ?? null };
    },

    quickPlan: async (feature: string, _projectDir: string, _callbacks: PlannerCallbacks): Promise<PlanResult> => {
      state.receivedFeatures.push(feature);
      const script = getNextPlan();
      state.quickPlanCallCount++;
      state.planCallCount++;
      if (script.throws) throw script.throws;
      return { tasks: script.tasks, spec: script.spec ?? '', plan: script.plan ?? '', usage: script.usage ?? null };
    },

    escalateHint: async (task: Task, error: string, _projectDir: string, _callbacks): Promise<EscalationResult> => {
      state.receivedErrors.push(error);
      state.escalateHintCallCount++;
      const script = getNextEscalation();
      if (script.throws) throw script.throws;
      return { success: script.success, output: script.output ?? '', code: script.code ?? null, usage: script.usage ?? null };
    },

    escalateFull: async (task: Task, error: string, _projectDir: string, _callbacks): Promise<EscalationResult> => {
      state.receivedErrors.push(error);
      state.escalateFullCallCount++;
      const script = getNextEscalation();
      if (script.throws) throw script.throws;
      return { success: script.success, output: script.output ?? '', code: script.code ?? null, usage: script.usage ?? null };
    },

    regenerate: async (_prompt, _type, _dir, _cb) => ({ text: '', usage: null }),
    review: async (_prompt, _dir, _cb) => ({ text: '', usage: null }),

    capabilities: {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsEffort: false,
      supportsImages: false,
    },
    dispose: () => {},
  };

  return { planner, state };
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.test.json`
Expected: PASS

---

### Task 2: Create `testing/helpers/faux/implementer.ts`

**Files:**
- Create: `testing/helpers/faux/implementer.ts`

- [ ] **Step 1: Write the faux implementer**

The real `Implementer` interface accepts `ImplementerOptions` (single object with `task`, `projectDir`, `config`, `context`, `onOutput`, etc.) and `RetryOptions` (extends ImplementerOptions with `error`, `attempt`, `kind`).

Create `testing/helpers/faux/implementer.ts`:

```typescript
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type { Implementer, ImplementerResult, ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';

export interface FauxImplementStep {
  success: boolean;
  output?: string;
  error?: string;
  usage?: TokenDelta;
  delayMs?: number;
  throws?: Error;
}

export interface FauxRetryStep {
  success: boolean;
  output?: string;
  error?: string;
  usage?: TokenDelta;
  throws?: Error;
}

export interface FauxImplementerOptions {
  steps?: FauxImplementStep[];
  retries?: FauxRetryStep[];
}

export interface FauxImplementerState {
  implementCallCount: number;
  retryCallCount: number;
  receivedTasks: Array<{ taskId: string; file: string }>;
  receivedErrors: string[];
}

export function fauxImplementer(opts: FauxImplementerOptions = {}): { implementer: Implementer; state: FauxImplementerState } {
  const steps = opts.steps ?? [{ success: true, output: 'ok' }];
  const retries = opts.retries ?? [];

  const state: FauxImplementerState = {
    implementCallCount: 0,
    retryCallCount: 0,
    receivedTasks: [],
    receivedErrors: [],
  };

  const implementer: Implementer = {
    implement: async (implOpts: ImplementerOptions): Promise<ImplementerResult> => {
      const task = implOpts.task;
      state.receivedTasks.push({ taskId: task.id as string, file: task.file });
      const script = steps[state.implementCallCount % steps.length];
      state.implementCallCount++;
      if (!script) throw new Error('fauxImplementer: no step script configured');
      if (script.throws) throw script.throws;
      if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs));
      if (implOpts.onOutput && script.output) implOpts.onOutput(script.output);
      return {
        success: script.success,
        output: script.output ?? '',
        error: script.error,
        usage: script.usage,
      };
    },

    retry: async (retryOpts: RetryOptions): Promise<ImplementerResult> => {
      state.receivedErrors.push(retryOpts.error);
      const script = retries[state.retryCallCount % Math.max(1, retries.length)];
      state.retryCallCount++;
      if (!script) throw new Error('fauxImplementer: no retry script configured');
      if (script.throws) throw script.throws;
      return {
        success: script.success,
        output: script.output ?? '',
        error: script.error,
        usage: script.usage,
      };
    },

    capabilities: { writesFiles: 'extracted-code' },
    dispose: () => {},
  };

  return { implementer, state };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.test.json`
Expected: PASS

---

### Task 3: Create `testing/helpers/faux/workflow.ts` harness

**Files:**
- Create: `testing/helpers/faux/workflow.ts`

- [ ] **Step 1: Write the workflow harness**

This brings everything together into one-call setup for pipeline tests.

Create `testing/helpers/faux/workflow.ts`:

```typescript
import { fauxPlanner, type FauxPlannerOptions, type FauxPlannerState } from './planner.js';
import { fauxImplementer, type FauxImplementerOptions, type FauxImplementerState } from './implementer.js';
import { makeBusRecorder } from '../bus-recorder.js';
import { makeConfig } from '../factories/config.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { Config } from '../../../src/core/schemas/config.js';

export interface FauxWorkflowOptions {
  planner?: FauxPlannerOptions;
  implementer?: FauxImplementerOptions;
  config?: Partial<Config>;
  autoApprove?: boolean;
}

export interface FauxWorkflowHarness {
  planner: ReturnType<typeof fauxPlanner>['planner'];
  implementer: ReturnType<typeof fauxImplementer>['implementer'];
  plannerState: FauxPlannerState;
  implementerState: FauxImplementerState;
  config: Config;
  events: EngineEvent[];
  eventsOfType: <T extends EngineEvent['type']>(type: T) => Extract<EngineEvent, { type: T }>[];
  bus: ReturnType<typeof makeBusRecorder>['bus'];
}

export function createFauxWorkflow(opts: FauxWorkflowOptions = {}): FauxWorkflowHarness {
  const { planner, state: plannerState } = fauxPlanner(opts.planner);
  const { implementer, state: implementerState } = fauxImplementer(opts.implementer);
  const { bus, events } = makeBusRecorder();
  const config = makeConfig(opts.config ?? {});

  function eventsOfType<T extends EngineEvent['type']>(type: T): Extract<EngineEvent, { type: T }>[] {
    return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
  }

  return {
    planner,
    implementer,
    plannerState,
    implementerState,
    config,
    events,
    eventsOfType,
    bus,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.test.json`
Expected: PASS (may need adjustment if `makeBusRecorder` or `makeConfig` have different signatures — read those files and adapt accordingly)

---

### Task 4: Write a basic integration test using the faux harness

**Files:**
- Create: `testing/helpers/faux/faux.test.ts`

- [ ] **Step 1: Write a smoke test**

```typescript
import { describe, it, expect } from 'vitest';
import { fauxPlanner } from './planner.js';
import { fauxImplementer } from './implementer.js';
import { makeTask } from '../factories/task.js';

describe('fauxPlanner', () => {
  it('returns scripted tasks and tracks call count', async () => {
    const task = makeTask({ id: 'T001', title: 'test task' });
    const { planner, state } = fauxPlanner({
      plans: [{ tasks: [task] }],
    });

    const result = await planner.plan('add feature', {});
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('T001');
    expect(state.planCallCount).toBe(1);
    expect(state.receivedFeatures).toEqual(['add feature']);
  });
});

describe('fauxImplementer', () => {
  it('returns scripted results and tracks calls', async () => {
    const { implementer, state } = fauxImplementer({
      steps: [{ success: true, output: 'done' }],
    });

    const result = await implementer.implement({ id: 'T001', file: 'src/foo.ts' }, {});
    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
    expect(state.implementCallCount).toBe(1);
    expect(state.receivedTasks[0]).toEqual({ taskId: 'T001', file: 'src/foo.ts' });
  });

  it('cycles through steps on repeated calls', async () => {
    const { implementer, state } = fauxImplementer({
      steps: [
        { success: true, output: 'first' },
        { success: false, error: 'fail' },
      ],
    });

    const r1 = await implementer.implement({ id: 'T001', file: 'a.ts' }, {});
    const r2 = await implementer.implement({ id: 'T002', file: 'b.ts' }, {});
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(false);
    expect(state.implementCallCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run testing/helpers/faux/faux.test.ts`
Expected: PASS

Note: If `makeTask` doesn't exist at that path or has a different signature, read `testing/helpers/factories/task.ts` and adapt. The faux test should use whatever factory pattern already exists in the project.
