import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { describe, it, expect, afterEach } from 'vitest';
import { buildSummary } from './build.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

type SummaryState = Parameters<typeof buildSummary>[0]['state'];

function makeState(overrides?: Partial<SummaryState>): SummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
    tokenUsage: makeUsage(),
    phase: 'complete',
    currentTaskIndex: 0,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('buildSummary', () => {
  it.each(['pass', 'unverified'] as const)(
    'uses effective verification for typed findings: %s',
    (status) => {
      const ref = setupProject(dirs);
      writeSpecFile(
        ref,
        'review.json',
        JSON.stringify({
          cycle: 0,
          at: '2026-01-01T00:00:00Z',
          outcome: 'fail',
          verdict: {
            tasks: [],
            criteria: [],
            findings: [
              {
                id: 'F1',
                kind: 'unverified',
                severity: 'blocking',
                taskId: null,
                file: null,
                line: null,
                text: 'Proof needed',
                acceptance: null,
                checkIds: ['K1'],
                criterionId: null,
              },
            ],
          },
          verification: [{ id: 'finding:F1', status, output: 'Recorded check' }],
        }),
      );
      const summary = buildSummary({
        ...ref,
        feature: 'auth',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      });
      expect(summary.review).toEqual(
        status === 'pass'
          ? { verdict: 'pass_with_notes', critical: 0, warnings: 1, notes: 0 }
          : { verdict: 'fail', critical: 1, warnings: 0, notes: 0 },
      );
    },
  );

  it('reports corrupt typed review data instead of using old Markdown', () => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.json', '{}');
    writeSpecFile(ref, 'review.md', '### Verdict\npass');
    expect(() =>
      buildSummary({
        ...ref,
        feature: 'auth',
        state: makeState(),
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      }),
    ).toThrow('Invalid typed review');
  });

  it('reads the verdict of a run that saved only review.md', () => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.md', '### Verdict\npass');
    const summary = buildSummary({
      ...ref,
      feature: 'auth',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(summary.review).toEqual({ verdict: 'pass', critical: 0, warnings: 0, notes: 0 });
  });

  it('all tasks completed locally → escalationRate 0', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(3);
    expect(summary.completedByLocal).toBe(3);
    expect(summary.escalatedToPlanner).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('records no workflow mode, even for a run that saved one', () => {
    const saved = { ...makeState(), mode: 'quick' as const };
    const summary = buildSummary({
      feature: 'auth',
      state: saved,
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary).not.toHaveProperty('mode');
  });

  it('run without a reviewer omits reviewer identity', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary).not.toHaveProperty('reviewerTool');
    expect(summary).not.toHaveProperty('reviewerModel');
  });

  it('records the reviewer tool and model of the seat the run was pinned to', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerTool: 'custom-endpoint',
      reviewerModel: 'custom-v4-flash',
    });

    expect(summary.reviewerTool).toBe('custom-endpoint');
    expect(summary.reviewerModel).toBe('custom-v4-flash');
  });

  it('after a seat swap the identity is the new seat and the spend stays on the old one', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState({
        tasks: [],
        tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
        implementerTool: 'custom-worker-api',
        implementerModel: 'deepseek-v4-flash',
      }),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      pricingCache: makePricedModelCache(),
    });

    expect(summary.implementerTool).toBe('ollama');
    expect(summary.costBreakdown?.providerCosts?.['custom-worker-api']).toBeDefined();
    expect(summary.costBreakdown?.providerCosts?.['ollama']).toBeUndefined();
    // The swapped-away seat is priced; the seat now in use is not, so a
    // breakdown that had followed the identity would read $0.00.
    expect(summary.costBreakdown?.actualImplementerCost).toBeCloseTo(0.42, 10);
  });

  it('mix of local/escalated/skipped/failed → correct counts', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'escalated' }),
        makeTask({ id: 'T003', status: 'skipped' }),
        makeTask({ id: 'T004', status: 'failed' }),
      ],
      tokenUsage: makeUsage({ plannerInput: 1000, implementerInput: 2000, escalationInput: 500 }),
    });

    const summary = buildSummary({
      feature: 'mixed',
      state,
      startTime: Date.now() - 10000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(4);
    expect(summary.completedByLocal).toBe(1);
    expect(summary.escalatedToPlanner).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.escalationRate).toBe(0.25);
  });

  it('classifies escalated-intermediate task breakdowns as escalated in summaries', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      tokenUsage: makeUsage({ implementerInput: 100, implementerOutput: 50 }),
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'Intermediate task',
          method: 'escalated-intermediate',
          implementerTokens: 150,
          escalationTokens: 0,
          retryCount: 1,
        },
      ],
    });

    const summary = buildSummary({
      feature: 'intermediate',
      state,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.completedByLocal).toBe(0);
    expect(summary.escalatedToPlanner).toBe(1);
    expect(summary.escalationRate).toBe(1);
  });

  it('zero tasks → no division by zero', () => {
    const state = makeState({
      tasks: [],
    });

    const summary = buildSummary({
      feature: 'empty',
      state,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(Number.isFinite(summary.escalationRate)).toBe(true);
    if (!summary.costBreakdown) throw new Error('expected costBreakdown on summary');
    expect(Number.isFinite(summary.costBreakdown.totalActualCost)).toBe(true);
  });

  it('token usage passed through correctly', () => {
    const usage = makeUsage({
      plannerInput: 100,
      plannerOutput: 200,
      implementerInput: 300,
      implementerOutput: 400,
      escalationInput: 50,
      escalationOutput: 60,
    });
    const state = makeState({ tokenUsage: usage });

    const summary = buildSummary({
      feature: 'tokens',
      state,
      startTime: Date.now() - 1000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.tokenUsage).toEqual(usage);
  });

  it("the state's task breakdowns pass through to summary", () => {
    const breakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 100,
        escalationTokens: 0,
        retryCount: 0,
      },
    ];

    const summary = buildSummary({
      feature: 'with-breakdowns',
      state: makeState({ taskBreakdowns: breakdowns }),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.taskBreakdown).toEqual([
      {
        taskId: taskId('T001'),
        taskTitle: 'task 1',
        method: 'local' as const,
        implementerTokens: 100,
        escalationTokens: 0,
        retryCount: 0,
      },
    ]);
    // Verify input array was NOT mutated
    expect(breakdowns[0]).not.toHaveProperty('cost');
  });

  it('includes model fields when provided', () => {
    const summary = buildSummary({
      feature: 'models',
      state: makeState(),
      startTime: Date.now() - 1000,
      plannerTool: 'custom-endpoint',
      plannerModel: 'claude-sonnet-4-20250514',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:14b',
    });

    expect(summary.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(summary.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('omits model fields when not provided', () => {
    const summary = buildSummary({
      feature: 'no-models',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.plannerModel).toBeUndefined();
    expect(summary.implementerModel).toBeUndefined();
  });
});

const SENTINEL = 'summary-breakdown-sentinel-90412';

function breakdownWithProse() {
  return [
    {
      taskId: taskId('T001'),
      taskTitle: `secret title ${SENTINEL}`,
      method: 'local' as const,
      implementerTokens: 100,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'ollama',
      model: 'qwen-local',
      implementerProfile: 'local-small',
      routingReason: `routing prose ${SENTINEL}`,
    },
  ];
}

describe('buildSummary taskBreakdown', () => {
  it('preserves task breakdown prose', () => {
    const summary = buildSummary({
      feature: 'kept',
      state: makeState({
        tasks: [makeTask({ id: 'T001', status: 'done' })],
        taskBreakdowns: breakdownWithProse(),
      }),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    const row = summary.taskBreakdown?.[0];
    if (!row) throw new Error('expected a task breakdown row');
    expect(row.taskTitle).toBe(`secret title ${SENTINEL}`);
    expect(row.routingReason).toBe(`routing prose ${SENTINEL}`);
  });
});

describe('buildSummary seat identity kinds', () => {
  it('returns the seat kinds beside their tools', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      plannerKind: 'cli',
      implementerTool: 'opencode',
      implementerKind: 'api',
      reviewerTool: 'codex',
      reviewerKind: 'cli',
    });

    expect(summary).toMatchObject({
      plannerKind: 'cli',
      implementerKind: 'api',
      reviewerKind: 'cli',
    });
  });

  it('pairs the kind with the seat the summary names, not with the state-pinned seat', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState({ plannerTool: 'retired-tool' }),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      plannerKind: 'cli',
      implementerTool: 'opencode',
      implementerKind: 'api',
    });

    expect(summary.plannerTool).toBe('claude-code');
    expect(summary.plannerKind).toBe('cli');
    expect(summary.implementerKind).toBe('api');
  });

  it('omits seat kinds a legacy identity never carried', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerTool: 'opencode',
    });

    expect(summary).not.toHaveProperty('plannerKind');
    expect(summary).not.toHaveProperty('implementerKind');
    expect(summary).not.toHaveProperty('reviewerKind');
  });
});
