import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../../core/schemas/task.js';
import type { RunStatus, StopReason } from '../../core/sessions/run-status.js';
import { atRestComposer, atRestRailStages, recordPhase } from './at-rest.js';

function openWith(stop: StopReason): RunStatus {
  return { kind: 'open', stop, resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 0 } };
}

function recordAt(input: { status: RunStatus; phase?: 'implementing' | 'complete' | 'planning' }) {
  return makeRunRecord({
    status: input.status,
    ...(input.phase !== undefined && {
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: input.phase }) },
    }),
  });
}

describe('atRestRailStages', () => {
  it('marks every stage done on a run that finished', () => {
    const stages = atRestRailStages(recordAt({ status: { kind: 'closed', as: 'complete' } }));
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('marks the stage a run somebody ended stopped on', () => {
    const stages = atRestRailStages(
      recordAt({ status: { kind: 'closed', as: 'ended' }, phase: 'implementing' }),
    );
    expect(stages[3]).toEqual({ stage: 'build', status: 'cancelled' });
  });

  it.each([
    ['paused', { kind: 'paused', at: 'mid-step' } as const, 'cancelled'],
    ['waiting', { kind: 'waiting', gate: 'spec' } as const, 'cancelled'],
    ['interrupted', { kind: 'interrupted' } as const, 'cancelled'],
    ['failed', { kind: 'failed', message: 'boom' } as const, 'failed'],
  ])('wears the %s mark the stop earned', (_label, stop, expected) => {
    const stages = atRestRailStages(recordAt({ status: openWith(stop), phase: 'implementing' }));
    expect(stages[3]?.status).toBe(expected);
  });

  it('leaves a run another process is driving on its active stage', () => {
    const stages = atRestRailStages(recordAt({ status: { kind: 'running' }, phase: 'planning' }));
    expect(stages[1]).toEqual({ stage: 'plan', status: 'active' });
  });
});

describe('atRestComposer', () => {
  it('takes a correction from a run that can be picked up', () => {
    const composer = atRestComposer(
      recordAt({ status: openWith({ kind: 'interrupted' }), phase: 'implementing' }),
    );
    expect(composer).toEqual({
      continuable: true,
      commandsOnly: false,
      placeholder: 'Type a correction, or ⏎ to continue…',
    });
  });

  it('takes commands only from a closed run', () => {
    const composer = atRestComposer(recordAt({ status: { kind: 'closed', as: 'complete' } }));
    expect(composer.continuable).toBe(false);
    expect(composer.commandsOnly).toBe(true);
  });

  it('takes commands only when the saved state cannot be read', () => {
    const composer = atRestComposer(
      makeRunRecord({ status: openWith({ kind: 'failed', message: 'unreadable' }) }),
    );
    expect(composer.continuable).toBe(false);
  });
});

describe('recordPhase', () => {
  it('reads the saved state first', () => {
    expect(recordPhase(recordAt({ status: { kind: 'running' }, phase: 'planning' }))).toBe(
      'planning',
    );
  });

  it('falls back to idle when nothing recorded a phase', () => {
    expect(recordPhase(makeRunRecord())).toBe('idle');
  });
});
