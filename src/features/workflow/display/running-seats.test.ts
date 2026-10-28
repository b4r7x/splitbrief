import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import { formatCollapsedSeatSpans, seatLineText } from '../../../core/crew/identity.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import type { ActiveOperation } from '../../../stores/workflow/operations/state.js';
import type { TasksState, WorkflowTask } from '../../../stores/workflow/tasks.js';
import { deriveRunningSeats } from './running-seats.js';

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 3,
    planner: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    validation: { testCommand: 'npm test' },
    workflow: { compactionFormat: 'auto' },
    ...overrides,
  };
}

function makeOperation(overrides: Partial<ActiveOperation> = {}): ActiveOperation {
  return {
    callId: 'call-1',
    role: 'planner',
    phase: 'planning',
    label: 'Planning',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    durationMs: null,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
    ...overrides,
  } as ActiveOperation;
}

const NO_BRIEF: TasksState = {
  currentTask: 0,
  currentAttempt: 1,
  totalTasks: 0,
  taskMap: new Map(),
  tasks: [],
};

function briefTasks(brief: Partial<WorkflowTask>): TasksState {
  const task: WorkflowTask = { id: 'T021', title: 'Brief', status: 'in_progress', ...brief };
  return {
    ...NO_BRIEF,
    currentTask: 1,
    totalTasks: 1,
    taskMap: new Map([[task.id, task]]),
    tasks: [task],
  };
}

const CODEX_ROUTE = { runner: 'codex', model: 'gpt-6-luna', axes: [], backendKind: 'cli' } as const;

function derive(
  input: Partial<Parameters<typeof deriveRunningSeats>[0]> & { config: Config },
): ReturnType<typeof deriveRunningSeats> {
  return deriveRunningSeats({
    active: null,
    tasks: NO_BRIEF,
    lifecycle: { status: 'running', phase: 'implementing' },
    halted: false,
    cutCallParked: false,
    passSeats: null,
    ...input,
  });
}

beforeEach(() => {
  modelCacheStore.reset();
  modelCacheStore.hydrateDetection({
    providers: [],
    cliTools: [],
    fetchedAt: 1,
    validatedAt: 1,
    generation: 0,
    requestId: 0,
    contexts: { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' },
    cliCatalogs: [
      { tool: 'codex', probedAt: 1, models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      { tool: 'opencode', probedAt: 1, models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }] },
    ],
  });
});

afterEach(() => modelCacheStore.reset());

describe('deriveRunningSeats', () => {
  it('overrides REVIEW when the review call runs on a different seat', () => {
    const config = makeTestConfig();
    const active = makeOperation({
      role: 'review',
      phase: 'final-review',
      label: 'Reviewing',
      runnerName: 'opencode',
      model: 'gpt-4o',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived.review?.seat).toMatchObject({
      tool: 'opencode',
      model: 'gpt-4o',
    });
    expect(derived.plan).toBeUndefined();
    expect(derived.build).toBeUndefined();
  });

  it('overrides PLAN when the plan call runs on a different seat', () => {
    const config = makeTestConfig();
    const active = makeOperation({
      role: 'planner',
      phase: 'planning',
      label: 'Planning',
      runnerName: 'codex',
      model: 'gpt-6-luna',
      backendKind: 'cli',
      axes: ['high'],
    });

    const derived = derive({ active, config });
    expect(derived.plan?.seat).toMatchObject({
      tool: 'codex',
      model: 'gpt-6-luna',
      axes: ['high'],
    });
    expect(derived.build).toBeUndefined();
    expect(derived.review).toBeUndefined();
  });

  it('overrides BUILD when the build call runs on a different seat', () => {
    const config = makeTestConfig();
    const active = makeOperation({
      role: 'implementer',
      phase: 'implementing',
      label: 'Building',
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived.build?.seat).toMatchObject({
      tool: 'claude-code',
      model: 'claude-3-5-sonnet',
    });
    expect(derived.plan).toBeUndefined();
    expect(derived.review).toBeUndefined();
  });

  it('returns no override for a call on the saved seat', () => {
    const config = makeTestConfig();
    const active = makeOperation({
      role: 'planner',
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived).toEqual({});
  });

  it('returns no override for a completed operation', () => {
    const config = makeTestConfig();
    const completed = makeOperation({
      status: 'completed',
      role: 'planner',
      runnerName: 'codex',
      model: 'gpt-6-luna',
      backendKind: 'cli',
    });

    const derived = derive({ active: completed, config });
    expect(derived).toEqual({});
  });

  it('returns no override when the saved seat has no model', () => {
    const config = makeTestConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
    });
    const active = makeOperation({
      role: 'planner',
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived).toEqual({});
  });

  it('returns no override for an inherited reviewer running on the planner', () => {
    const config = makeTestConfig({
      reviewer: undefined,
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });
    const active = makeOperation({
      role: 'review',
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived).toEqual({});
  });

  it('feeds the derived seat into formatCollapsedSeatSpans and reflects the running model', () => {
    const config = makeTestConfig();
    const active = makeOperation({
      role: 'implementer',
      runnerName: 'opencode',
      model: 'gpt-4o',
      backendKind: 'cli',
    });

    const derived = derive({ active, config });
    expect(derived.build).toBeDefined();

    const spans = formatCollapsedSeatSpans({
      planner: config.planner,
      build: derived.build?.seat ?? config.implementer,
      reviewer: undefined,
    });
    const text = seatLineText(spans);
    expect(text.toLowerCase()).toContain('gpt-4o');
    expect(text.toLowerCase()).not.toContain('gpt-5');
  });

  it('keeps naming the running brief seat between its attempts', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    const derived = derive({ config, tasks: briefTasks({ route: CODEX_ROUTE }) });
    expect(derived.build?.seat).toMatchObject({ tool: 'codex', model: 'gpt-6-luna' });
  });

  it('keeps naming the running brief seat while an escalation call runs inside it', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });
    const active = makeOperation({
      role: 'escalation',
      phase: 'escalating',
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
      backendKind: 'cli',
    });

    const derived = derive({
      active,
      config,
      tasks: briefTasks({ route: CODEX_ROUTE }),
      lifecycle: { status: 'running', phase: 'escalating' },
    });
    expect(derived.build?.seat).toMatchObject({ tool: 'codex', model: 'gpt-6-luna' });
  });

  it('keeps naming the running brief seat while a mid-step correction waits', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    const derived = derive({
      config,
      tasks: briefTasks({ route: CODEX_ROUTE }),
      lifecycle: { status: 'interrupted', phase: 'implementing' },
    });
    expect(derived.build?.seat).toMatchObject({ tool: 'codex', model: 'gpt-6-luna' });
  });

  it('names the saved seat once the brief has ended', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    expect(derive({ config, tasks: briefTasks({ status: 'done', route: CODEX_ROUTE }) })).toEqual(
      {},
    );
  });

  it('names the saved seat after a stop inside a brief', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    const derived = derive({
      config,
      tasks: briefTasks({ route: CODEX_ROUTE }),
      lifecycle: { status: 'cancelled', phase: 'implementing' },
    });
    expect(derived).toEqual({});
  });

  it('names the saved seat while a halt inside a brief waits', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    expect(derive({ config, tasks: briefTasks({ route: CODEX_ROUTE }), halted: true })).toEqual({});
  });

  it('names the saved seat on a run at rest inside a brief', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    const derived = derive({
      config,
      tasks: briefTasks({ route: CODEX_ROUTE }),
      lifecycle: { status: 'paused', phase: 'implementing' },
    });
    expect(derived).toEqual({});
  });

  it('names the saved seat for a pending brief the build has not started', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    });

    expect(derive({ config, tasks: briefTasks({ status: 'pending' }) })).toEqual({});
    expect(
      derive({ config, tasks: briefTasks({ status: 'pending', route: CODEX_ROUTE }) }),
    ).toEqual({});
  });

  it('returns no override for a brief on the saved seat', () => {
    const config = makeTestConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' },
    });

    expect(derive({ config, tasks: briefTasks({ route: CODEX_ROUTE }) })).toEqual({});
  });

  it.each([
    { role: 'planner' as const, phase: 'planning' as const },
    { role: 'review' as const, phase: 'final-review' as const },
  ])('takes no seat from a $role status record, which knows no effort', ({ role, phase }) => {
    const seat = {
      kind: 'cli' as const,
      tool: 'claude-code' as const,
      model: 'claude-3-5-sonnet',
      effort: 'high' as const,
    };
    const config = makeTestConfig({ planner: seat, reviewer: seat });
    const active = makeOperation({
      callId: `status-fallback:${role}:${phase}`,
      role,
      phase,
      runnerName: 'claude-code',
      model: 'claude-3-5-sonnet',
    });

    expect(derive({ active, config, lifecycle: { status: 'running', phase } })).toEqual({});
  });

  it.each([
    { kind: 'shell' as const, command: './impl.sh', model: 'auto' },
    { kind: 'agent' as const, command: 'my-agent', model: 'local-7b' },
  ])('returns no override for a $kind BUILD call on the saved seat', (seat) => {
    const config = makeTestConfig({ implementer: seat });
    const active = makeOperation({
      role: 'implementer',
      phase: 'implementing',
      runnerName: seat.command,
      model: seat.model,
      axes: [],
      backendKind: seat.kind,
    });

    expect(derive({ active, config })).toEqual({});
  });

  it.each([
    { seat: { kind: 'shell' as const, command: './impl.sh', model: 'auto' }, runner: 'shell' },
    { seat: { kind: 'agent' as const, command: 'my-agent', model: 'local-7b' }, runner: 'agent' },
    {
      seat: {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local' as const,
        model: 'qwen3',
        apiBase: 'http://localhost:11434/v1',
      },
      runner: 'ollama',
    },
  ])('returns no override for a $seat.kind brief on the saved seat', ({ seat, runner }) => {
    const config = makeTestConfig({ implementer: seat });
    const route = { runner, model: seat.model, axes: [], backendKind: seat.kind };

    expect(derive({ config, tasks: briefTasks({ route }) })).toEqual({});
  });

  it('keeps PLAN on its saved shell seat while its call runs', () => {
    const config = makeTestConfig({ planner: { kind: 'shell', command: './plan.sh' } });
    const active = makeOperation({ runnerName: './plan.sh', axes: [], backendKind: 'shell' });

    expect(derive({ active, config, lifecycle: { status: 'running', phase: 'planning' } })).toEqual(
      {},
    );
  });

  it('keeps = PLAN while a shell planner that holds the review seat runs a review call', () => {
    const config = makeTestConfig({
      reviewer: undefined,
      planner: { kind: 'shell', command: './plan.sh' },
    });
    const call = makeOperation({
      role: 'review',
      phase: 'final-review',
      runnerName: './plan.sh',
      axes: [],
      backendKind: 'shell',
    });
    const status = makeOperation({
      callId: 'status-fallback:review:final-review',
      role: 'review',
      phase: 'final-review',
      runnerName: 'shell',
    });
    const lifecycle = { status: 'running', phase: 'final-review' } as const;

    expect(derive({ active: call, config, lifecycle })).toEqual({});
    expect(derive({ active: status, config, lifecycle })).toEqual({});
  });

  it('keeps a saved shell seat when the call runs another command of the same kind and model', () => {
    const config = makeTestConfig({
      implementer: { kind: 'shell', command: './impl.sh', model: 'auto' },
    });
    const active = makeOperation({
      role: 'implementer',
      phase: 'implementing',
      runnerName: './other.sh',
      model: 'auto',
      axes: [],
      backendKind: 'shell',
    });

    expect(derive({ active, config }).build).toBeUndefined();
  });
});
