import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
import { adviseMode } from '../../engine/orchestrator/planning/mode-advisor.js';
import { updateModeAdvice, type ModeAdviceState } from './mode-advice.js';

const EMPTY: ModeAdviceState = { mode: null, advice: null };

function adviceEvent(prompt: string): EngineEvent {
  return { type: 'mode_advice', ts: 1, phase: 'planning', ...adviseMode(prompt, 'standard') };
}

describe('updateModeAdvice', () => {
  it('keeps the latest verdict, a none verdict included', () => {
    const upgrade = adviceEvent('add auth middleware to protect admin routes');
    const none: EngineEvent = {
      type: 'mode_advice',
      ts: 2,
      phase: 'planning',
      kind: 'none',
      risk: 'normal',
      currentMode: 'standard',
      suggestedMode: 'standard',
      confidence: 0.6,
      factors: [],
      missing: [],
    };

    const state = [upgrade, none].reduce(updateModeAdvice, EMPTY);

    expect(state.advice?.kind).toBe('none');
  });

  it('keeps the mode the latest mode_resolved names', () => {
    const resolved = (mode: 'quick' | 'standard'): EngineEvent => ({
      type: 'mode_resolved',
      ts: 1,
      phase: 'planning',
      mode,
      approve: 'default',
    });

    const state = [resolved('standard'), resolved('quick')].reduce(updateModeAdvice, EMPTY);

    expect(state.mode).toBe('quick');
  });

  it('leaves the verdict alone for every other event', () => {
    const advised = updateModeAdvice(EMPTY, adviceEvent('fix typo in footer'));
    const warning: EngineEvent = { type: 'warning', ts: 3, phase: 'planning', message: 'w' };

    expect(updateModeAdvice(advised, warning)).toBe(advised);
  });
});
