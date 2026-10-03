import { describe, expect, it } from 'vitest';
import {
  getRailStages,
  selectRailStage,
  type RailStage,
  type RailStageState,
  type RailStageStatus,
} from './rail-stages.js';

function statusOf(
  stages: readonly RailStageState[],
  stage: RailStage,
): RailStageStatus | undefined {
  return stages.find((state) => state.stage === stage)?.status;
}

describe('rail stage status', () => {
  it.each([
    'researching',
    'specifying',
    'reviewing-spec',
    'clarifying',
    'constitution-check',
    'planning',
    'reviewing-plan',
    'reviewing-briefs',
    'analyzing',
  ] as const)('folds the pre-build phase %s into Plan', (phase) => {
    const stages = getRailStages(phase);
    expect(stages.map((state) => state.stage)).toEqual(['plan', 'build', 'review']);
    expect(statusOf(stages, 'plan')).toBe('active');
    expect(statusOf(stages, 'build')).toBe('pending');
  });

  it('marks all three stages done when a run completes', () => {
    const stages = getRailStages('complete');
    expect(stages.every((state) => state.status === 'done')).toBe(true);
  });

  it('marks the stop stage of an ended run', () => {
    const stages = getRailStages('implementing', { halted: 'failed' });
    expect(statusOf(stages, 'plan')).toBe('done');
    expect(statusOf(stages, 'build')).toBe('failed');
    expect(statusOf(stages, 'review')).toBe('pending');
  });
});

describe('Form C selection', () => {
  it('selects Plan for idle and Review for complete', () => {
    expect(selectRailStage(getRailStages('idle'))).toEqual({
      state: { stage: 'plan', status: 'pending' },
      index: 0,
    });
    expect(selectRailStage(getRailStages('complete'))).toEqual({
      state: { stage: 'review', status: 'done' },
      index: 2,
    });
  });
});
