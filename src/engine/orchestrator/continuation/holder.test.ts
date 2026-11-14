import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { createContinuationHolder } from './holder.js';

describe('createContinuationHolder', () => {
  it('hands the seed to the step it was recorded at, once', () => {
    const holder = createContinuationHolder({
      step: { kind: 'planner', call: 'spec' },
      partial: 'half a spec',
      steer: plainUserMessage('shorter'),
    });

    expect(holder.take({ kind: 'planner', call: 'spec' })).toEqual({
      partial: 'half a spec',
      steer: plainUserMessage('shorter'),
    });
    expect(holder.take({ kind: 'planner', call: 'spec' })).toBeUndefined();
  });

  it('withholds a brief seed from another task, kind, or attempt', () => {
    const holder = createContinuationHolder({
      step: { kind: 'brief', taskId: taskId('T001'), attempt: 2 },
      partial: 'half a brief',
    });

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 2 })).toBeUndefined();
    expect(holder.take({ kind: 'planner', call: 'tasks' })).toBeUndefined();
    // A reset attempt of the same brief is a fresh try, not this partial's resume:
    // the ladder cleared attempt 2 back to 0, so the mid-step partial no longer applies.
    expect(holder.take({ kind: 'brief', taskId: taskId('T001'), attempt: 0 })).toBeUndefined();
    expect(holder.take({ kind: 'brief', taskId: taskId('T001'), attempt: 2 })).toEqual({
      partial: 'half a brief',
    });
  });

  it('holds a steer for the step a boundary park stopped before', () => {
    const holder = createContinuationHolder();
    holder.hold(
      { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
      plainUserMessage('use the new helper'),
    );

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 0 })).toEqual({
      steer: plainUserMessage('use the new helper'),
    });
  });

  it('holds nothing when the operator continued without words', () => {
    const holder = createContinuationHolder();
    holder.hold({ kind: 'brief', taskId: taskId('T002'), attempt: 0 }, undefined);

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 0 })).toBeUndefined();
  });

  it('keeps a cut review in its own cycle', () => {
    const holder = createContinuationHolder({
      step: { kind: 'review', cycle: 0 },
      partial: 'an earlier review finding',
    });

    expect(holder.take({ kind: 'review', cycle: 1 })).toBeUndefined();
    expect(holder.take({ kind: 'review', cycle: 0 })).toEqual({
      partial: 'an earlier review finding',
    });
  });

  it('gives a steer an old run parked at a retired planner call to the planning session', () => {
    const holder = createContinuationHolder({
      step: { kind: 'planner', call: 'tasks' },
      steer: plainUserMessage('keep it small'),
    });

    expect(holder.take({ kind: 'planner', call: 'plan' })).toEqual({
      steer: plainUserMessage('keep it small'),
    });
  });

  it('gives an empty cut only to its recorded step and only once', () => {
    const step = { kind: 'brief' as const, taskId: taskId('T001'), attempt: 1 };
    const holder = createContinuationHolder({ step, partial: '' });

    expect(holder.take({ ...step, attempt: 2 })).toBeUndefined();
    expect(holder.take(step)).toEqual({ partial: '' });
    expect(holder.take(step)).toBeUndefined();
  });
});
