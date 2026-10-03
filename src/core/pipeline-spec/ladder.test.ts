import { describe, expect, it } from 'vitest';
import { framingForAttempt, HAND_BACK_MAX_CHARS, LADDER, RETRY_FRAMINGS } from './ladder.js';

describe('LADDER', () => {
  it('lists the rungs in escalation order', () => {
    expect(LADDER.map((rung) => rung.id)).toEqual(['recipe-fix', 'local', 'consult', 'takeover']);
  });

  it('spends no retry on the recipe-fix rung and counts the local rung', () => {
    expect(LADDER[0]).toEqual({ id: 'recipe-fix', who: 'implementer', consumesRetry: false });
    expect(LADDER[1]).toEqual({
      id: 'local',
      who: 'implementer',
      count: 'DEFAULT_LOCAL_RETRIES',
    });
  });

  it('runs the consult rung with the planner before the implementer', () => {
    expect(LADDER[2]).toEqual({ id: 'consult', who: 'planner-then-implementer' });
  });

  it('marks takeover as the only rung the engine does not run', () => {
    expect(LADDER.filter((rung) => rung.engine === false).map((rung) => rung.id)).toEqual([
      'takeover',
    ]);
  });
});

describe('framingForAttempt', () => {
  it('returns the framing keyed by attempt', () => {
    expect(framingForAttempt(1)).toBe(RETRY_FRAMINGS[1]);
    expect(framingForAttempt(2)).toBe(RETRY_FRAMINGS[2]);
  });

  it('framingForAttempt falls back to the third framing past attempt 3', () => {
    expect(framingForAttempt(4)).toBe(RETRY_FRAMINGS[3]);
    expect(framingForAttempt(9)).toBe(RETRY_FRAMINGS[3]);
  });
});

describe('HAND_BACK_MAX_CHARS', () => {
  it('bounds the implementer hand-back at 2000 characters', () => {
    expect(HAND_BACK_MAX_CHARS).toBe(2000);
  });
});
