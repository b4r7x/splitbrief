import { describe, expect, it } from 'vitest';
import { framingForAttempt, HAND_BACK_MAX_CHARS, LADDER, RETRY_FRAMINGS } from './ladder.js';

describe('LADDER', () => {
  it('lists the rungs in escalation order', () => {
    expect(LADDER.map((rung) => rung.id)).toEqual(['recipe-fix', 'local', 'consult']);
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
});

describe('framingForAttempt', () => {
  it('returns the framing keyed by attempt', () => {
    expect(framingForAttempt(1, false)).toBe(RETRY_FRAMINGS[1]);
    expect(framingForAttempt(2, false)).toBe(RETRY_FRAMINGS[2]);
  });

  it('framingForAttempt falls back to the third framing past attempt 3', () => {
    expect(framingForAttempt(4, false)).toBe(RETRY_FRAMINGS[3]);
    expect(framingForAttempt(9, false)).toBe(RETRY_FRAMINGS[3]);
  });

  it('does not tell a fix brief to fix failures that are not its job', () => {
    expect(framingForAttempt(1, true)).toBe(
      "Your previous attempt had an error. Fix what it names as yours; failures it names as not this brief's job are left to their fix tasks or the next review:",
    );
    expect(framingForAttempt(1, false)).toBe(RETRY_FRAMINGS[1]);
    expect(framingForAttempt(2, true)).toBe(RETRY_FRAMINGS[2]);
  });
});

describe('HAND_BACK_MAX_CHARS', () => {
  it('bounds the implementer hand-back at 2000 characters', () => {
    expect(HAND_BACK_MAX_CHARS).toBe(2000);
  });
});
