import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';

import {
  createBusTextHandler,
  publishPlannerStatus,
  publishValidation,
  publishError,
  publishGitCommit,
  publishDriftChainDetected,
} from './events.js';
import { addUsageAndSave } from './state-ops.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('emit-test');
  dirs.push(projectDir);
  const sessionId = 'sess-emit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('createBusTextHandler', () => {
  it('stamps an implementer role so streamed implementer output is not attributed to the planner', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'implementing' }, { role: 'implementer' });

    handler('writing src/a.ts');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'planner_text',
      text: 'writing src/a.ts',
      role: 'implementer',
    });
  });

  it('marks planner document output as markdown when requested', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'planning' }, { content: 'markdown' });

    handler('### Plan\n');

    expect(events[0]).toMatchObject({
      type: 'planner_text',
      text: '### Plan\n',
      content: 'markdown',
    });
  });

  it('omits the role when none is supplied so planner output keeps its default attribution', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'planning' });

    handler('drafting the plan');

    expect(events[0]).toMatchObject({ type: 'planner_text', text: 'drafting the plan' });
    expect('role' in (events[0] as Record<string, unknown>)).toBe(false);
  });
});

describe('publishPlannerStatus', () => {
  it('falls back to plannerTool / plannerModel from state when extra is not provided', () => {
    const { bus, events } = makeBusRecorder();
    const state = {
      ...createInitialState('test'),
      plannerTool: 'claude-code',
      plannerModel: 'opus-4',
    };

    publishPlannerStatus(bus, state, 'running');

    expect(events[0]).toMatchObject({
      type: 'planner_status',
      status: 'running',
      tool: 'claude-code',
      model: 'opus-4',
    });
  });

  it('omits tool and model when neither state nor extra provides them', () => {
    const { bus, events } = makeBusRecorder();

    publishPlannerStatus(bus, createInitialState('test'), 'done');

    const e = events[0];
    if (!e) throw new Error('expected one planner_status event');
    expect(e).toMatchObject({ type: 'planner_status', status: 'done' });
    expect('tool' in e).toBe(false);
    expect('model' in e).toBe(false);
  });

  it('extra.tool / extra.model override state values', () => {
    const { bus, events } = makeBusRecorder();
    const state = {
      ...createInitialState('test'),
      plannerTool: 'claude-code',
      plannerModel: 'opus-4',
    };

    publishPlannerStatus(bus, state, 'done', { tool: 'agent-sdk', model: 'sonnet-4' });

    expect(events[0]).toMatchObject({ tool: 'agent-sdk', model: 'sonnet-4' });
  });
});

describe('publishValidation — result phase aggregates stage outcomes', () => {
  it('passed=true only when every stage passed', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [
          { stage: 'typecheck', passed: true },
          { stage: 'lint', passed: true },
          { stage: 'test', passed: true },
        ],
        startTime: Date.now() - 100,
      },
    );

    expect(events[0]).toMatchObject({
      type: 'validate',
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    });
    expect((events[0] as Record<string, unknown>)['error']).toBeUndefined();
  });

  it('passed=false with first failing stage error on partial failure', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [
          { stage: 'typecheck', passed: true },
          { stage: 'lint', passed: false, error: 'lint error' },
        ],
        startTime: Date.now(),
      },
    );

    expect(events[0]).toMatchObject({
      type: 'validate',
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      error: 'lint error',
    });
  });

  it('duration is measured from startTime', () => {
    const { bus, events } = makeBusRecorder();
    const startTime = Date.now() - 500;

    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [{ stage: 'typecheck', passed: true }],
        startTime,
      },
    );

    expect((events[0] as Record<string, unknown>)['duration']).toBeGreaterThanOrEqual(400);
  });

  it('a skipped stage is reported via the skipped channel, not as a passing stage', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [
          { stage: 'typecheck', passed: true },
          { stage: 'lint', passed: true, skipped: true },
          { stage: 'test', passed: true },
        ],
        startTime: Date.now(),
      },
    );

    expect(events[0]).toMatchObject({
      type: 'validate',
      passed: true,
      stages: { typecheck: true, lint: false, test: true },
      skipped: { lint: true },
    });
  });

  it('omits the skipped channel when no stage was skipped', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [{ stage: 'typecheck', passed: true }],
        startTime: Date.now(),
      },
    );

    expect('skipped' in (events[0] as Record<string, unknown>)).toBe(false);
  });
});

describe('publish* payload forwarding', () => {
  it('publishError — forwards message and timestamp', () => {
    const { bus, events } = makeBusRecorder();
    publishError({ bus: bus, phase: 'implementing' }, 'something went wrong');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it('publishGitCommit — includes file when provided', () => {
    const { bus, events } = makeBusRecorder();
    publishGitCommit(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      'chore: commit',
      'src/a.ts',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'git_commit',
      message: 'chore: commit',
      file: 'src/a.ts',
    });
  });

  it('publishGitCommit — omits file when not provided', () => {
    const { bus, events } = makeBusRecorder();
    publishGitCommit(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      'chore: commit',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'git_commit', message: 'chore: commit' });
    expect('file' in (events[0] as Record<string, unknown>)).toBe(false);
  });

  it('publishDriftChainDetected — publishes event with correct type and all required fields', () => {
    const { bus, events } = makeBusRecorder();
    const chain = {
      chainLength: 3,
      score: 0.75,
      uniqueOutOfBoundsFiles: ['src/a.ts', 'src/b.ts'],
      representativePath: 'src/a.ts',
      detectedAtTaskId: 'T003' as import('../../core/schemas/task.js').TaskId,
      ts: Date.now(),
    };
    publishDriftChainDetected({ bus: bus, phase: 'implementing' }, chain, 0.6);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'drift_chain_detected',
      phase: 'implementing',
      chainLength: 3,
      score: 0.75,
      threshold: 0.6,
      uniqueOutOfBoundsFiles: ['src/a.ts', 'src/b.ts'],
      representativePath: 'src/a.ts',
    });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });
});

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    ...overrides,
  };
}

describe('addUsageAndSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates token usage into the new state and emits a cost-update event', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }) });
    const { bus, events } = makeBusRecorder();

    const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    });

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cost_update' });
  });

  it('returns the same state instance and emits nothing when usage is null', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { bus, events } = makeBusRecorder();

    const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'implementer', null);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});
