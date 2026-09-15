import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../schemas/task.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { createInitialState } from '../state/machine.js';
import {
  deriveRunStatus,
  NO_ARTIFACTS,
  resumeStep,
  type ArtifactPresence,
  type RunStatus,
} from './run-status.js';
import { plannerStepsFor } from '../pipeline-spec/steps.js';

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...createInitialState('feat'), ...overrides };
}

function statusOf(
  overrides: Partial<WorkflowState>,
  liveness: 'alive' | 'not-alive' = 'not-alive',
) {
  return deriveRunStatus({ state: state(overrides), liveness, artifacts: NO_ARTIFACTS });
}

function stopOf(overrides: Partial<WorkflowState>): RunStatus {
  return statusOf(overrides);
}

function withArtifacts(present: Partial<ArtifactPresence>): ArtifactPresence {
  return { ...NO_ARTIFACTS, ...present };
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

  it('reports a pending recovery as halted and carries the issue', () => {
    const issue = makeRecoveryIssue();
    const status = stopOf({ phase: 'validating-task', pendingRecovery: issue });
    expect(status).toMatchObject({ kind: 'open', stop: { kind: 'halted', issue } });
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
    expect(status).toMatchObject({ stop: { kind: 'paused', at: 'mid-step' } });
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
    ).toMatchObject({ stop: { kind: 'paused', at: 'boundary' } });

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
    ).toMatchObject({ stop: { kind: 'paused', at: 'mid-step' } });
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
    expect(status).toMatchObject({ stop: { kind: 'paused', at: 'boundary' } });
  });

  it('reads a legacy awaitingContinue with no interrupt record as paused mid-step', () => {
    expect(stopOf({ phase: 'planning', awaitingContinue: true })).toMatchObject({
      stop: { kind: 'paused', at: 'mid-step' },
    });
  });

  it.each([
    ['reviewing-spec', 'spec'],
    ['reviewing-plan', 'plan'],
    ['reviewing-briefs', 'briefs'],
  ] as const)('reports %s as waiting on the %s gate', (phase, gate) => {
    expect(stopOf({ phase })).toMatchObject({ stop: { kind: 'waiting', gate } });
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
    expect(status).toMatchObject({ stop: { kind: 'failed', message: 'Planning failed.' } });
  });

  it('falls back to interrupted when nothing says why the run stopped', () => {
    expect(stopOf({ phase: 'implementing' })).toMatchObject({ stop: { kind: 'interrupted' } });
  });

  it('carries the step the run picks up at on every open status', () => {
    const status = deriveRunStatus({
      state: state({ phase: 'reviewing-plan' }),
      liveness: 'not-alive',
      artifacts: NO_ARTIFACTS,
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
    expect(resumeStep(state({ phase }), NO_ARTIFACTS)).toEqual({ kind: 'gate', gate });
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
      expect(resumeStep(implementing, NO_ARTIFACTS)).toEqual({
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
    expect(resumeStep(past, NO_ARTIFACTS)).toEqual({ kind: 'review', cycle: 0 });
  });

  it('resumes final review at the fix cycle it reached', () => {
    const reviewing = state({
      phase: 'final-review',
      reviewFixes: { cycle: 2, findings: {} },
    });
    expect(resumeStep(reviewing, NO_ARTIFACTS)).toEqual({ kind: 'review', cycle: 2 });
  });

  it('resumes a run parked at complete on a failed review at the review', () => {
    expect(resumeStep(state({ phase: 'complete', reviewStatus: 'failed' }), NO_ARTIFACTS)).toEqual({
      kind: 'review',
      cycle: 0,
    });
  });

  it('starts standard mode at research and walks past every artifact already written', () => {
    const idle = state({ phase: 'idle', mode: 'standard' });
    expect(resumeStep(idle, NO_ARTIFACTS)).toEqual({ kind: 'planner', call: 'research' });
    expect(resumeStep(idle, withArtifacts({ research: true }))).toEqual({
      kind: 'planner',
      call: 'spec',
    });
    expect(resumeStep(idle, withArtifacts({ research: true, spec: true }))).toEqual({
      kind: 'planner',
      call: 'plan',
    });
    expect(resumeStep(idle, withArtifacts({ research: true, spec: true, plan: true }))).toEqual({
      kind: 'planner',
      call: 'tasks',
    });
  });

  it('treats an absent mode as standard', () => {
    expect(resumeStep(state({ phase: 'idle' }), NO_ARTIFACTS)).toEqual({
      kind: 'planner',
      call: 'research',
    });
  });

  it('gives quick mode only its briefs call', () => {
    const quick = state({ phase: 'idle', mode: 'quick' });
    expect(resumeStep(quick, NO_ARTIFACTS)).toEqual({ kind: 'planner', call: 'tasks' });
    expect(resumeStep(quick, withArtifacts({ tasks: true }))).toEqual({
      kind: 'planner',
      call: 'tasks',
    });
  });

  it('walks the speckit order through clarify, constitution and analyze', () => {
    const speckit = state({ phase: 'idle', mode: 'speckit' });
    expect(resumeStep(speckit, withArtifacts({ research: true, spec: true }))).toEqual({
      kind: 'planner',
      call: 'clarify',
    });
    expect(
      resumeStep(speckit, withArtifacts({ research: true, spec: true, clarifications: true })),
    ).toEqual({ kind: 'planner', call: 'constitution' });
    expect(
      resumeStep(
        speckit,
        withArtifacts({ research: true, spec: true, clarifications: true, constitution: true }),
      ),
    ).toEqual({ kind: 'planner', call: 'plan' });
    expect(
      resumeStep(
        speckit,
        withArtifacts({
          research: true,
          spec: true,
          clarifications: true,
          constitution: true,
          plan: true,
        }),
      ),
    ).toEqual({ kind: 'planner', call: 'tasks' });
    expect(
      resumeStep(
        speckit,
        withArtifacts({
          research: true,
          spec: true,
          clarifications: true,
          constitution: true,
          plan: true,
          tasks: true,
        }),
      ),
    ).toEqual({ kind: 'planner', call: 'analyze' });
  });

  it('resumes a planner phase at its own call, or the next one it has not written', () => {
    expect(resumeStep(state({ phase: 'specifying', mode: 'standard' }), NO_ARTIFACTS)).toEqual({
      kind: 'planner',
      call: 'spec',
    });
    expect(
      resumeStep(state({ phase: 'specifying', mode: 'standard' }), withArtifacts({ spec: true })),
    ).toEqual({ kind: 'planner', call: 'plan' });
    expect(
      resumeStep(state({ phase: 'planning', mode: 'speckit' }), withArtifacts({ plan: true })),
    ).toEqual({ kind: 'planner', call: 'tasks' });
  });

  it('reads its call order from the pipeline step table', () => {
    const speckit = state({ phase: 'idle', mode: 'speckit' });
    const order = plannerStepsFor('speckit', 'all').map((step) => step.call);
    expect(order).toEqual([
      'research',
      'spec',
      'clarify',
      'constitution',
      'plan',
      'tasks',
      'analyze',
    ]);
    expect(resumeStep(speckit, NO_ARTIFACTS)).toEqual({ kind: 'planner', call: order[0] });
  });

  it('stops at the last call of the mode when every artifact is already on disk', () => {
    const all: ArtifactPresence = {
      research: true,
      spec: true,
      plan: true,
      tasks: true,
      clarifications: true,
      constitution: true,
      analyze: true,
      review: true,
    };
    expect(resumeStep(state({ phase: 'idle', mode: 'standard' }), all)).toEqual({
      kind: 'planner',
      call: 'tasks',
    });
  });
});
