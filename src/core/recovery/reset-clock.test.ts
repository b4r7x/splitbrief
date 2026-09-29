import { describe, expect, it } from 'vitest';
import { formatResetNote, formatStoredReset, stripRecoveryResetClause } from './reset-clock.js';

function localTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatResetNote', () => {
  it('says only the clock for a reset later today', () => {
    expect(formatResetNote(localTime(2026, 7, 13, 17), localTime(2026, 7, 13, 9, 30))).toBe(
      'resets 17:00',
    );
  });

  it('pads a single-digit hour so the clock column never shifts', () => {
    expect(formatResetNote(localTime(2026, 7, 13, 9, 5), localTime(2026, 7, 13, 8))).toBe(
      'resets 09:05',
    );
  });

  it('carries the date when the reset is not today', () => {
    expect(formatResetNote(localTime(2026, 7, 14, 12), localTime(2026, 7, 13, 23))).toBe(
      'resets Jul 14, 12:00',
    );
  });
});

describe('formatStoredReset', () => {
  // A stored sentence replays on other days, where a bare clock would name the wrong one.
  it('always carries the date, even for a reset later today', () => {
    expect(formatStoredReset(localTime(2026, 9, 29, 23, 59))).toBe('Sep 29, 23:59');
    expect(formatStoredReset(localTime(2026, 7, 13, 9, 5))).toBe('Jul 13, 09:05');
  });
});

describe('stripRecoveryResetClause', () => {
  // Each tool's captured limit wording, as `src/engine/runners/usage-limit.ts` records it.
  it.each([
    ["You've hit your session limit · resets 3:45pm", "You've hit your session limit"],
    [
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 1:02 PM.",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    ],
    [
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 5 days 22 hours 11 minutes.",
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing).",
    ],
    [
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)',
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. (response may be truncated)',
    ],
  ])('drops the reset from %j and keeps the rest of the words', (words, kept) => {
    expect(stripRecoveryResetClause(words)).toBe(kept);
  });

  it.each([
    'Your quota resets in a few days. Visit the dashboard.',
    // A countdown inside a sentence is part of that sentence, not a clause of its own.
    'Your limit resets in 5h. Upgrade to keep going.',
  ])('keeps %j whole', (words) => {
    expect(stripRecoveryResetClause(words)).toBe(words);
  });
});
