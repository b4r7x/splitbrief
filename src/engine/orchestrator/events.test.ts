import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';

import {
  createBusTextHandler,
  publishPlannerStatus,
  publishValidation,
  publishError,
  publishWarning,
  publishGitCommit,
  publishDriftChainDetected,
  createImplementerPublisher,
} from './events.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { protectEngineEventForConsumer } from '../events/protection/protect.js';

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

describe('createImplementerPublisher', () => {
  it('publishes failures without fabricating an absent model', () => {
    const { bus, events } = makeBusRecorder();

    createImplementerPublisher(bus).publishFailed({
      phase: 'implementing',
      taskId: makeTask().id,
    });

    expect(events[0]).toMatchObject({ type: 'implementer_generate_failed' });
    expect(events[0] && 'model' in events[0]).toBe(false);
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
      attempted: { typecheck: true, lint: true, test: true },
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
      attempted: { typecheck: true, lint: true, test: false },
      error: 'lint error',
    });
  });

  it('marks only stages present in validation results as attempted', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(
      { bus: bus, phase: 'implementing' },
      'T001' as import('../../core/schemas/task.js').TaskId,
      {
        phase: 'result',
        results: [{ stage: 'test', passed: false, error: 'test error' }],
        startTime: Date.now(),
      },
    );

    expect(events[0]).toMatchObject({
      type: 'validate',
      passed: false,
      stages: { typecheck: false, lint: false, test: false },
      attempted: { typecheck: false, lint: false, test: true },
      error: 'test error',
    });
  });

  it('forwards validation command metadata on progress and result events', () => {
    const { bus, events } = makeBusRecorder();
    const taskId = 'T001' as import('../../core/schemas/task.js').TaskId;

    publishValidation({ bus: bus, phase: 'implementing' }, taskId, {
      phase: 'progress',
      stages: { typecheck: false, lint: false, test: false },
      activeStage: 'typecheck',
      commands: { typecheck: 'npm run typecheck' },
      startTime: Date.now(),
    });
    publishValidation({ bus: bus, phase: 'implementing' }, taskId, {
      phase: 'result',
      results: [{ stage: 'typecheck', passed: true, command: 'npm run typecheck' }],
      startTime: Date.now(),
    });

    expect(events[0]).toMatchObject({
      type: 'validate',
      status: 'running',
      activeStage: 'typecheck',
      commands: { typecheck: 'npm run typecheck' },
    });
    expect(events[1]).toMatchObject({
      type: 'validate',
      status: 'done',
      commands: { typecheck: 'npm run typecheck' },
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
      attempted: { typecheck: true, lint: true, test: true },
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
    publishError({ bus: bus, phase: 'implementing', message: 'something went wrong' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it('publishWarning — preserves explicitly safe operational warning text under transcript-off', () => {
    const { bus, events } = makeBusRecorder();
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      safety: {
        category: 'queue',
        code: 'queue_full',
        transcriptSafe: true,
      },
    });

    const warning = events[0];
    if (warning === undefined) {
      expect(warning).toBeDefined();
      return;
    }

    expect(warning).toMatchObject({
      type: 'warning',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
      transcriptSafe: true,
    });
    expect(
      protectEngineEventForConsumer(warning, {
        context: 'session-log',
        persistTranscript: false,
      }),
    ).toMatchObject({
      type: 'warning',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
      transcriptSafe: true,
    });
  });

  it('publishWarning — omits unclassified warning text under transcript-off', () => {
    const { bus, events } = makeBusRecorder();
    publishWarning({ bus: bus, phase: 'implementing', message: 'private prompt detail' });

    const warning = events[0];
    if (warning === undefined) {
      expect(warning).toBeDefined();
      return;
    }

    expect(
      protectEngineEventForConsumer(warning, {
        context: 'session-log',
        persistTranscript: false,
      }),
    ).toMatchObject({ type: 'warning', message: TRANSCRIPT_OMITTED_MESSAGE });
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
