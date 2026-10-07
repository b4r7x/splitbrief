import { describe, expect, it } from 'vitest';
import { REVIEW_STATUSES } from './enums.js';
import { ChangedFilesSnapshotSchema, WorkflowStateSchema } from './workflow.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { PlanSchema } from './plan.js';

const tokenUsage = makeUsage();

const task = {
  id: 'T001',
  title: 'Do work',
  action: 'modify',
  file: 'src/a.ts',
  dependsOn: [],
  description: 'Do work',
  tests: [],
  constraints: [],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
};

function state(
  overrides: Partial<{
    phase: string;
    currentTaskIndex: number;
    tasks: (typeof task)[];
  }> = {},
) {
  return {
    stateVersion: 4,
    stateRevision: 1,
    phase: 'reviewing-briefs',
    feature: 'quality recovery',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    startedAt: '2026-08-13T00:00:00.000Z',
    tokenUsage,
    ...overrides,
  };
}

describe('WorkflowStateSchema v4', () => {
  it('parses the complete changed-files snapshot contract', () => {
    const snapshot = {
      head: 'abc123',
      files: ['src/a.ts'],
      dirtyFileContents: { 'src/a.ts': 'before\n' },
      gitlinks: ['vendor/module'],
      baselineFileHashes: { 'src/a.ts': 'hash' },
      ignoreProjectDir: '/tmp/staged-project',
    };

    expect(ChangedFilesSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('carries the run-start validation baseline through v4 persistence', () => {
    const validationBaseline = {
      failingStages: ['typecheck'],
      commands: { typecheck: 'npm run typecheck' },
      failures: { typecheck: ['src/a.ts(12,5)'] },
    };
    const persisted = WorkflowStateSchema.parse(
      JSON.parse(JSON.stringify({ ...state(), validationBaseline })),
    );

    expect(persisted).toMatchObject({ validationBaseline });
  });

  it('keeps the run-level plan through v4 persistence', () => {
    const plan = PlanSchema.parse(makePlanProposal());
    const persisted = WorkflowStateSchema.parse(JSON.parse(JSON.stringify({ ...state(), plan })));

    expect(persisted.plan).toEqual(plan);
  });

  it.each([
    ['all', 'plan'],
    ['spec', 'plan'],
    ['default', 'plan'],
    ['plan', 'plan'],
    ['none', 'none'],
  ])('loads a saved approve %s as %s', (saved, loaded) => {
    expect(WorkflowStateSchema.parse({ ...state(), approve: saved }).approve).toBe(loaded);
  });

  it('requires v4 persistence identity and rejects v3 or future state versions', () => {
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 3 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 5 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateRevision: undefined }).success).toBe(
      false,
    );
  });

  it('legacy v4 keys are stripped on parse', () => {
    const parsed = WorkflowStateSchema.safeParse({
      ...state(),
      briefRecovery: { junk: true },
      generation: null,
      permit: null,
      authorityRevision: 3,
      stateFence: { token: 1, ownerId: 'x' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('briefRecovery');
      expect(parsed.data).not.toHaveProperty('generation');
      expect(parsed.data).not.toHaveProperty('permit');
      expect(parsed.data).not.toHaveProperty('authorityRevision');
      expect(parsed.data).not.toHaveProperty('stateFence');
    }
  });

  it('retains task graph and active-index invariants under v4', () => {
    expect(
      WorkflowStateSchema.safeParse(state({ tasks: [task, { ...task, title: 'Duplicate' }] }))
        .success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'validating-task', tasks: [] })).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'implementing', currentTaskIndex: 2, tasks: [task] }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({
          phase: 'implementing',
          currentTaskIndex: 1,
          tasks: [{ ...task, status: 'done' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts every shared review status and refuses the review-phase vocabulary', () => {
    for (const status of REVIEW_STATUSES) {
      expect(WorkflowStateSchema.safeParse({ ...state(), reviewStatus: status }).success).toBe(
        true,
      );
    }
    expect(WorkflowStateSchema.safeParse({ ...state(), reviewStatus: 'written' }).success).toBe(
      false,
    );
  });

  it('rejects unknown top-level persisted fields instead of silently accepting them', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        clarifications: [{ id: 'c1', question: 'q', answer: 'a' }],
      }).success,
    ).toBe(false);
  });

  it('keeps the persisted seat kinds beside their tools', () => {
    const parsed = WorkflowStateSchema.parse({
      ...state(),
      plannerTool: 'claude-code',
      plannerKind: 'cli',
      implementerTool: 'opencode',
      implementerKind: 'api',
    });

    expect(parsed.plannerKind).toBe('cli');
    expect(parsed.implementerKind).toBe('api');
    expect(parsed).not.toHaveProperty('reviewerKind');
  });

  it('reads a legacy state with no kinds as unknown, never as a default kind', () => {
    const parsed = WorkflowStateSchema.parse({
      ...state(),
      plannerTool: 'claude-code',
      implementerTool: 'opencode',
    });

    expect(parsed).not.toHaveProperty('plannerKind');
    expect(parsed).not.toHaveProperty('implementerKind');
  });

  it('loads an old state that carries none of the seat-switch fields', () => {
    const parsed = WorkflowStateSchema.parse(state());

    expect(parsed.seatSwitches).toBeUndefined();
    expect(parsed.interruptedStep).toBeUndefined();
  });

  it('keeps a seat switch record, a seat-sourced park and an automatic offer', () => {
    const parsed = WorkflowStateSchema.parse({
      ...state({
        phase: 'implementing',
        tasks: [{ ...task, status: 'in_progress' }],
      }),
      seatSwitches: [
        {
          seat: 'build',
          from: 'codex',
          to: 'claude-code',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'abc123',
          ts: '2026-10-07T10:00:00.000Z',
        },
      ],
      interruptedStep: {
        step: { kind: 'brief', taskId: 'T001', attempt: 2 },
        source: 'seat',
        cut: 'mid-step',
        at: '2026-10-07T10:00:00.000Z',
      },
      pendingRecovery: {
        id: 'rec1',
        reason: 'runner-usage-limit',
        phase: 'implementing',
        status: 'awaiting-user',
        seat: 'build',
        files: [],
        affectedTaskIds: [],
        message: 'Usage limit',
        details: [],
        resetAt: '2026-10-07T10:00:00.000Z',
        switchSeat: {
          seat: 'build',
          candidates: [{ tool: 'codex' }],
          auto: { candidate: { tool: 'codex' }, configRevision: 'abc123' },
        },
        availableActions: ['retry-later', 'end-run'],
        recommendedAction: 'retry-later',
        createdAt: '2026-10-07T10:00:00.000Z',
      },
    });

    expect(parsed.seatSwitches?.[0]?.cause).toBe('runner-usage-limit');
    expect(parsed.interruptedStep?.source).toBe('seat');
    expect(parsed.pendingRecovery?.switchSeat?.auto).toEqual({
      candidate: { tool: 'codex' },
      configRevision: 'abc123',
    });
  });
});
