import { describe, expect, it } from 'vitest';
import { REVIEW_STATUSES } from './enums.js';
import {
  ChangedFilesSnapshotSchema,
  QueuedMessageSchema,
  WorkflowStateSchema,
} from './workflow.js';
import { makeMessage } from '#testing/helpers/queue.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { PlanSchema } from './plan.js';
import { plainUserMessage } from '../types/user-input.js';

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
  it('persists expanded resume messages while accepting states without them', () => {
    const resumeUserMessages = [
      {
        ts: '2026-10-10T00:00:00.000Z',
        phase: 'planning',
        displayText: 'Use @notes.md',
        text: 'Use @notes.md\n\n--- @notes.md ---\nPELICAN-42',
      },
      {
        ts: '2026-10-10T00:00:01.000Z',
        phase: 'planning',
        displayText: 'Answer with @notes.md',
        answerIndex: 0,
      },
    ];
    const parsed = WorkflowStateSchema.parse({ ...state(), resumeUserMessages });
    expect(
      WorkflowStateSchema.parse(JSON.parse(JSON.stringify(parsed))).resumeUserMessages,
    ).toEqual(resumeUserMessages);
    expect(WorkflowStateSchema.parse(state()).resumeUserMessages).toBeUndefined();
  });

  it('normalizes old queues and persists the complete new message fields', () => {
    const old = {
      id: 'old',
      text: 'old steer',
      queuedAt: '2026-10-10T00:00:00.000Z',
      phase: 'planning',
      deliveredViaNative: false,
    };
    expect(QueuedMessageSchema.parse(old)).toMatchObject(plainUserMessage(old.text));
    const message = {
      ...old,
      text: 'Use @notes.md\n\nPELICAN-42',
      displayText: 'Use @notes.md',
      images: [
        {
          id: 'image-1',
          kind: 'image',
          path: '/real/image.png',
          sizeBytes: 5,
          mimeType: 'image/png',
        },
      ],
      attachedInputs: [
        { path: '/real/notes.md', kind: 'text' },
        { path: '/real/image.png', kind: 'image' },
      ],
    };
    const parsed = WorkflowStateSchema.parse({ ...state(), messageQueue: [message] });
    expect(
      WorkflowStateSchema.parse(JSON.parse(JSON.stringify(parsed))).messageQueue[0],
    ).toMatchObject(message);
  });

  it('loads old queue entries and preserves the mid-call fields', () => {
    const old = makeMessage('old message');
    const midCall = { ...makeMessage('live message'), id: 'live', deliveredMidCall: true };
    const uncertain = {
      ...makeMessage('uncertain message'),
      id: 'uncertain',
      possibleDuplicate: true,
    };
    const parsed = WorkflowStateSchema.parse({
      ...state(),
      messageQueue: [old, midCall, uncertain],
    });
    expect(parsed.messageQueue).toEqual([old, midCall, uncertain]);
    expect(QueuedMessageSchema.safeParse({ ...old, deliveredMidCall: false }).success).toBe(false);
  });

  it('preserves account details on seat-switch records', () => {
    const parsed = WorkflowStateSchema.parse({
      ...state(),
      seatSwitches: [
        {
          seat: 'build',
          from: 'old seat',
          to: 'new seat',
          cause: 'runner-usage-limit',
          accountCause: 'balance',
          headline: 'Balance spent on OpenCode CLI',
          auto: true,
          configRevision: 'revision',
          ts: '2026-10-10T12:57:12.126Z',
        },
      ],
    });

    expect(parsed.seatSwitches?.[0]?.accountCause).toBe('balance');
    expect(parsed.seatSwitches?.[0]?.headline).toBe('Balance spent on OpenCode CLI');
  });

  it('loads seat-switch records without account details unchanged', () => {
    const record = {
      seat: 'build',
      from: 'old seat',
      to: 'new seat',
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'revision',
      ts: '2026-10-10T12:57:12.126Z',
    };
    const parsed = WorkflowStateSchema.parse({ ...state(), seatSwitches: [record] });

    expect(parsed.seatSwitches?.[0]).toEqual(record);
    expect(parsed.seatSwitches?.[0]?.accountCause).toBeUndefined();
    expect(parsed.seatSwitches?.[0]?.headline).toBeUndefined();
  });

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

  it('strips retired gate state from v4 persistence', () => {
    const validationBaseline = {
      failingStages: ['typecheck'],
      commands: { typecheck: 'npm run typecheck' },
      failures: { typecheck: ['src/a.ts(12,5)'] },
    };
    const persisted = WorkflowStateSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...state(),
          validationBaseline,
          pendingBoundary: { batch: 1, afterTaskId: 'T001' },
        }),
      ),
    );

    expect(persisted).not.toHaveProperty('validationBaseline');
    expect(persisted).not.toHaveProperty('pendingBoundary');
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

  it('loads a state the run-start suite wrote and drops its baseline', () => {
    const parsed = WorkflowStateSchema.safeParse({
      ...state(),
      fullSuiteBaseline: { test: ['src/legacy.test.ts:5'] },
      fullSuiteBaselineStages: {
        test: { kind: 'timed-out', durationMs: 600_508, timeoutMs: 600_000 },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('fullSuiteBaseline');
      expect(parsed.data).not.toHaveProperty('fullSuiteBaselineStages');
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

  it('loads an old fix task and pending input that carry no red', () => {
    const finding = { id: 'F1', text: 'The greeting is wrong', acceptance: null };
    const input = { id: 'P1', kind: 'defect', source: 'check', text: 'lint failed', file: null };
    const parsed = WorkflowStateSchema.parse({
      ...state({ phase: 'implementing' }),
      tasks: [{ ...task, fix: { cycle: 1, findings: [finding] } }],
      pendingTriage: { inputs: [input] },
    });

    expect(parsed.tasks[0]?.fix?.findings).toEqual([finding]);
    expect(parsed.pendingTriage?.inputs).toEqual([input]);
  });

  it('drops the stage an older fix task and pending input carry', () => {
    const red = { checkIds: ['K1'], output: 'broken' };
    const finding = { id: 'P1', text: 'K1 failed', acceptance: null, ...red };
    const input = {
      id: 'P1',
      kind: 'defect',
      source: 'check',
      text: 'K1 failed',
      file: null,
      ...red,
    };
    const parsed = WorkflowStateSchema.parse({
      ...state({ phase: 'implementing' }),
      tasks: [{ ...task, fix: { cycle: 1, findings: [{ ...finding, stage: 'test' }] } }],
      pendingTriage: { inputs: [{ ...input, stage: 'test' }] },
    });

    expect(parsed.tasks[0]?.fix?.findings).toEqual([finding]);
    expect(parsed.pendingTriage?.inputs).toEqual([input]);
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
