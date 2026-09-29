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
  it('shows Plan active and Spec pending while a saved quick run researches', () => {
    const stages = getRailStages('researching', { mode: 'quick' });
    expect(statusOf(stages, 'plan')).toBe('active');
    expect(statusOf(stages, 'spec')).toBe('pending');
  });

  it('marks Plan through Review done and leaves Spec pending when a quick run completes', () => {
    const stages = getRailStages('complete', { mode: 'quick' });
    expect(stages.filter((state) => state.status === 'done').map((state) => state.stage)).toEqual([
      'plan',
      'briefs',
      'build',
      'review',
    ]);
    expect(statusOf(stages, 'spec')).toBe('pending');
  });

  it('marks the stop stage of an ended quick run', () => {
    const stages = getRailStages('implementing', { halted: 'failed', mode: 'quick' });
    expect(statusOf(stages, 'build')).toBe('failed');
    expect(statusOf(stages, 'review')).toBe('pending');
  });

  it('shows Spec active and Plan pending while standard Research runs', () => {
    const stages = getRailStages('researching');
    expect(statusOf(stages, 'spec')).toBe('active');
    expect(statusOf(stages, 'plan')).toBe('pending');
  });
});

describe('Form C selection', () => {
  it('selects Plan for quick idle and Review for quick complete', () => {
    expect(selectRailStage(getRailStages('idle', { mode: 'quick' }), 'quick')).toEqual({
      state: { stage: 'plan', status: 'pending' },
      index: 1,
    });
    expect(selectRailStage(getRailStages('complete', { mode: 'quick' }), 'quick')).toEqual({
      state: { stage: 'review', status: 'done' },
      index: 4,
    });
  });
});
