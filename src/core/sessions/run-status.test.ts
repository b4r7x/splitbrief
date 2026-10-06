import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../schemas/task.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { createInitialState, transition } from '../state/machine.js';
import { deriveRunStatus, resumeStep, type RunStatus } from './run-status.js';

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...createInitialState('feat'), ...overrides };
}

function statusOf(
  overrides: Partial<WorkflowState>,
  liveness: 'alive' | 'not-alive' = 'not-alive',
) {
  return deriveRunStatus({ state: state(overrides), liveness });
}

function stopOf(overrides: Partial<WorkflowState>): RunStatus {
  return statusOf(overrides);
}

describe('deriveRunStatus', () => {
  it('closes an explicitly ended run before anything else', () => {
    expect(
      statusOf({
        closed: { at: '2026-09-01T00:00:00.000Z', as: 'ended' },
        phase: 'complete',
        reviewStatus: 'passed',
        pendingRecovery: makeRecoveryIssue(),
      }),
    ).toEqual({ kind: 'closed', as: 'ended' });
  });

  it('closes a run that finished with a passing review', () => {
    expect(statusOf({ phase: 'complete', reviewStatus: 'passed' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
  });

  it('leaves a run that reached complete with a failed review open', () => {
    expect(statusOf({ phase: 'complete', reviewStatus: 'failed' }).kind).toBe('open');
  });

  it('reports a live run as running, ahead of every stop reason', () => {
    expect(
      statusOf({ phase: 'implementing', pendingRecovery: makeRecoveryIssue() }, 'alive'),
    ).toEqual({ kind: 'running' });
  });

  it('reports a pending recovery as waiting for you on the halt and carries the issue', () => {
    const issue = makeRecoveryIssue();
    const status = stopOf({ phase: 'validating-task', pendingRecovery: issue });
    expect(status).toMatchObject({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
    });
  });

  it('reports an unanswered planner question as waiting for you on the question', () => {
    const status = stopOf({
      phase: 'planning',
      pendingPlannerConversation: {
        call: 'plan',
        text: 'Which DB?',
        questions: [],
        answers: [],
        answered: false,
      },
    });
    expect(status).toEqual({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'question' } },
      resumeAt: { kind: 'planner', call: 'plan' },
    });
  });

  it('reads an interrupted step with a captured partial as paused mid-step', () => {
    const status = stopOf({
      phase: 'implementing',
      interruptedStep: {
        step: { kind: 'review', cycle: 0 },
        source: 'user',
        partialRef: { kind: 'session-log', index: 12 },
        at: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(status).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    });
  });

  it('reads the cut the stop recorded in preference to guessing from the partial', () => {
    expect(
      stopOf({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
          source: 'user',
          cut: 'boundary',
          at: '2026-09-01T00:00:00.000Z',
        },
      }),
    ).toMatchObject({ stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } } });

    expect(
      stopOf({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'planner', call: 'spec' },
          source: 'user',
          cut: 'mid-step',
          at: '2026-09-01T00:00:00.000Z',
        },
      }),
    ).toMatchObject({ stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } } });
  });

  it('reads an interrupted step with no partial as paused at a boundary', () => {
    const status = stopOf({
      phase: 'implementing',
      interruptedStep: {
        step: { kind: 'review', cycle: 0 },
        source: 'watchdog',
        at: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(status).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
    });
  });

  it('reads a legacy awaitingContinue with no interrupt record as paused mid-step', () => {
    expect(stopOf({ phase: 'planning', awaitingContinue: true })).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    });
  });

  it.each([
    ['reviewing-spec', 'spec'],
    ['reviewing-plan', 'plan'],
    ['reviewing-briefs', 'briefs'],
  ] as const)('reports %s as waiting on the %s gate', (phase, gate) => {
    expect(stopOf({ phase })).toMatchObject({
      stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate, reopens: false } },
    });
  });

  it('reports a recorded failure with its message', () => {
    const status = stopOf({
      phase: 'idle',
      lastFailure: {
        step: { kind: 'planner', call: 'spec' },
        message: 'Planning failed.',
        at: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(status).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'failed', message: 'Planning failed.' } },
    });
  });

  it('forgets a recorded failure once the run picks the step up again', () => {
    const failed = state({
      phase: 'specifying',
      lastFailure: {
        step: { kind: 'planner', call: 'spec' },
        message: 'Planning failed.',
        at: '2026-09-01T00:00:00.000Z',
      },
    });
    const resumed = transition(failed, { type: 'RESUME_STEP' });

    expect(deriveRunStatus({ state: resumed, liveness: 'not-alive' })).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    });
  });

  it('falls back to interrupted when nothing says why the run stopped', () => {
    expect(stopOf({ phase: 'implementing' })).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    });
  });

  // The briefs of a run whose steps open no plan gate once waited in reviewing-plan, so a run saved
  // there is at its briefs call. A state that records no mode or approve level stays at the gate.
  // A saved `spec` or `all` loads as `plan`, so such a run now reads as waiting at the plan gate.
  it.each([
    ['quick', 'plan', 'at its briefs call'],
    ['standard', 'none', 'at its briefs call'],
    ['speckit', 'none', 'at its briefs call'],
    ['standard', 'plan', 'at the plan gate'],
    ['speckit', 'plan', 'at the plan gate'],
    [undefined, undefined, 'at the plan gate'],
  ] as const)(
    'reads a run saved in reviewing-plan (mode %s, approve %s) as stopped %s',
    (mode, approve, at) => {
      const saved = state({
        phase: 'reviewing-plan',
        ...(mode !== undefined && { mode }),
        ...(approve !== undefined && { approve }),
      });
      const status = deriveRunStatus({
        state: saved,
        liveness: 'not-alive',
      });
      expect(status).toMatchObject(
        at === 'at the plan gate'
          ? {
              stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'plan' } },
              resumeAt: { kind: 'gate', gate: 'plan' },
            }
          : {
              stop: { kind: 'stopped', on: { kind: 'interrupted' } },
              resumeAt: { kind: 'planner', call: 'plan' },
            },
      );
    },
  );

  // A planning session's plan only reaches reviewing-plan when its approval opens, so it waits
  // there whatever level the run records.
  it('reads a planning session parked in reviewing-plan as waiting at the plan gate', () => {
    const status = deriveRunStatus({
      state: state({
        phase: 'reviewing-plan',
        mode: 'standard',
        approve: 'none',
        plan: {
          summary: 'One task.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'Works.', checkIds: ['K1'] }],
          checks: [],
          validation: null,
        },
      }),
      liveness: 'not-alive',
    });
    expect(status).toMatchObject({
      stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'plan', reopens: true } },
      resumeAt: { kind: 'gate', gate: 'plan' },
    });
  });

  it('carries the step the run picks up at on every open status', () => {
    const status = deriveRunStatus({
      state: state({ phase: 'reviewing-plan' }),
      liveness: 'not-alive',
    });
    expect(status).toMatchObject({ resumeAt: { kind: 'gate', gate: 'plan' } });
  });
});

describe('resumeStep', () => {
  it.each([
    ['reviewing-spec', 'spec'],
    ['reviewing-plan', 'plan'],
    ['reviewing-briefs', 'briefs'],
  ] as const)('resumes %s at its gate', (phase, gate) => {
    expect(resumeStep(state({ phase }))).toEqual({ kind: 'gate', gate });
  });

  it.each(['implementing', 'validating-task', 'escalating'] as const)(
    'resumes %s at the brief and attempt it was on',
    (phase) => {
      const task = makeTask({ id: 'T002' });
      const implementing = makeImplState([makeTask({ id: 'T001' }), task], {
        phase,
        currentTaskIndex: 1,
        attempt: 2,
      });
      expect(resumeStep(implementing)).toEqual({
        kind: 'brief',
        taskId: taskId('T002'),
        attempt: 2,
      });
    },
  );

  it('resumes at the review when the brief index is past the last brief', () => {
    const past = makeImplState([makeTask({ id: 'T001' })], {
      phase: 'implementing',
      currentTaskIndex: 1,
    });
    expect(resumeStep(past)).toEqual({ kind: 'review', cycle: 0 });
  });

  it('resumes final review at the fix cycle it reached', () => {
    const reviewing = state({
      phase: 'final-review',
      reviewFixes: { cycle: 2, findings: {} },
    });
    expect(resumeStep(reviewing)).toEqual({ kind: 'review', cycle: 2 });
  });

  it('resumes a run parked at complete on a failed review at the review', () => {
    expect(resumeStep(state({ phase: 'complete', reviewStatus: 'failed' }))).toEqual({
      kind: 'review',
      cycle: 0,
    });
  });

  it.each([
    ['idle', 'standard'],
    ['idle', 'quick'],
    ['researching', 'standard'],
    ['specifying', 'speckit'],
    ['clarifying', 'speckit'],
    ['planning', 'standard'],
    ['analyzing', 'speckit'],
  ] as const)('resumes a run in %s (mode %s) at its planning session', (phase, mode) => {
    expect(resumeStep(state({ phase, mode }))).toEqual({ kind: 'planner', call: 'plan' });
  });

  it('resumes a run with planner questions at its planning session, whatever call asked them', () => {
    const asked = state({
      phase: 'researching',
      pendingPlannerConversation: {
        call: 'research',
        text: 'Which DB?',
        questions: [],
        answers: [],
        answered: false,
      },
    });
    expect(resumeStep(asked)).toEqual({ kind: 'planner', call: 'plan' });
  });
});

describe('a run with a workspace', () => {
  const WORKTREE: NonNullable<WorkflowState['workspace']> = {
    kind: 'worktree',
    path: '/tmp/project/.splitbrief/worktrees/run',
    base: { snapshotId: 'workspace-base', head: 'abc123' },
  };
  const AT = '2026-10-03T00:00:00.000Z';
  const passed = (overrides: Partial<WorkflowState> = {}): Partial<WorkflowState> => ({
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: WORKTREE,
    ...overrides,
  });

  it('ready-to-apply for a passed worktree run', () => {
    expect(statusOf(passed())).toEqual({ kind: 'ready-to-apply', override: false });
  });

  it('ready-to-apply for a passed staged-copy run', () => {
    expect(statusOf(passed({ workspace: { ...WORKTREE, kind: 'staged-copy' } }))).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
  });

  it('an applied record without a closure does not become ready again', () => {
    expect(
      statusOf(passed({ applied: { at: AT, backupId: 'apply-1', files: ['src/a.ts'] } })).kind,
    ).toBe('open');
  });

  it('a pending apply-conflict halt reads open halted, not ready', () => {
    const issue = makeRecoveryIssue();
    expect(statusOf(passed({ pendingRecovery: issue }))).toEqual({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
      resumeAt: { kind: 'apply' },
    });
  });

  it('an applying run resumes at the apply step', () => {
    const applying = passed({ applying: { at: AT, backupId: 'apply-1' } });
    expect(statusOf(applying)).toEqual({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
      resumeAt: { kind: 'apply' },
    });
    expect(resumeStep(state(applying))).toEqual({ kind: 'apply' });
  });

  it('ready-to-apply with override for accepted-as-is', () => {
    expect(
      statusOf(passed({ reviewStatus: 'failed', acceptedAsIs: { at: AT, findings: ['F1'] } })),
    ).toEqual({ kind: 'ready-to-apply', override: true });
  });

  it('a failed review without an override stays open', () => {
    expect(statusOf(passed({ reviewStatus: 'failed' })).kind).toBe('open');
  });

  it('closed applied after APPLY_DONE', () => {
    const ready = state(passed());
    const applying = transition(ready, { type: 'APPLY_START', backupId: 'apply-1' });
    const applied = transition(applying, { type: 'APPLY_DONE', files: ['src/a.ts'] });
    expect(deriveRunStatus({ state: applied, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'applied',
    });
  });

  it('closed discarded', () => {
    const discarded = transition(state(passed()), { type: 'CLOSE_RUN', as: 'discarded' });
    expect(deriveRunStatus({ state: discarded, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'discarded',
    });
  });

  it('old passed run without workspace stays closed complete', () => {
    expect(statusOf({ phase: 'complete', reviewStatus: 'passed' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
  });

  it('old interrupted run stays open', () => {
    expect(statusOf({ phase: 'implementing' })).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    });
  });

  it('checkout-kind workspace closes on pass', () => {
    expect(statusOf(passed({ workspace: { ...WORKTREE, kind: 'checkout' } }))).toEqual({
      kind: 'closed',
      as: 'complete',
    });
  });

  it('a checkout run accepted as is after a failed review closes, its verdict still failed', () => {
    expect(
      statusOf(
        passed({
          workspace: { ...WORKTREE, kind: 'checkout' },
          reviewStatus: 'failed',
          acceptedAsIs: { at: AT, findings: ['F1'] },
        }),
      ),
    ).toEqual({ kind: 'closed', as: 'complete' });
  });

  // A skipped task-cadence review records an override too; it must not read as accepting the final
  // review that failed after it, while that review's halt waits for an answer.
  it('a checkout run whose final review failed after a skipped task review waits at its halt', () => {
    const issue = makeRecoveryIssue({ reason: 'review-failed' });
    expect(
      statusOf(
        passed({
          workspace: { ...WORKTREE, kind: 'checkout' },
          reviewStatus: 'failed',
          acceptedAsIs: { at: AT, findings: ['Skipped the T001 review'] },
          pendingRecovery: issue,
        }),
      ),
    ).toMatchObject({ kind: 'open', stop: { kind: 'waiting-for-you', on: { kind: 'halt' } } });
  });

  it('a checkout-mode run accepted as is closes unless its halt waits', () => {
    const issue = makeRecoveryIssue({ reason: 'review-failed' });
    const acceptedAsIs = { at: AT, findings: ['F1'] };

    expect(statusOf({ phase: 'complete', reviewStatus: 'failed', acceptedAsIs })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
    expect(
      statusOf({ phase: 'complete', reviewStatus: 'failed', acceptedAsIs, pendingRecovery: issue }),
    ).toEqual({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
      resumeAt: { kind: 'review', cycle: 0 },
    });
  });

  it('ready outranks liveness', () => {
    expect(statusOf(passed(), 'alive')).toEqual({ kind: 'ready-to-apply', override: false });
  });

  it('an interrupted step on a ready run reads open paused', () => {
    expect(
      statusOf(
        passed({
          interruptedStep: { step: { kind: 'apply' }, source: 'user', cut: 'mid-step', at: AT },
        }),
      ),
    ).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused' } },
      resumeAt: { kind: 'apply' },
    });
  });
});
