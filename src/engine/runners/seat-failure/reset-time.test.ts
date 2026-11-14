import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_RATE_LIMIT_BODY,
  ANTIGRAVITY_QUOTA,
  CLAUDE_SESSION_LIMIT,
  CLAUDE_WEEKLY_LIMIT,
  CODEX_LIMIT_MESSAGE,
  CODEX_LIMIT_RELATIVE,
  GROQ_RATE_LIMIT,
} from '#testing/helpers/usage-limit-fixtures.js';
import { parseUsageLimitReset } from './reset-time.js';

const CODEX_LIMIT_BARE_CLOCK =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:27 PM.";

describe('parseUsageLimitReset', () => {
  const now = new Date('2026-08-07T10:00:00');

  it('parses the codex absolute reset from the live record', () => {
    const resetsAt = parseUsageLimitReset(CODEX_LIMIT_MESSAGE, now);
    expect(resetsAt).not.toBeNull();
    expect(resetsAt?.getFullYear()).toBe(2026);
    expect(resetsAt?.getMonth()).toBe(7);
    expect(resetsAt?.getDate()).toBe(8);
    expect(resetsAt?.getHours()).toBe(15);
    expect(resetsAt?.getMinutes()).toBe(27);
  });

  it('parses the codex bare-clock reset from the live record', () => {
    expect(CODEX_LIMIT_BARE_CLOCK).toContain('or try again at 3:27 PM.');
    const resetsAt = parseUsageLimitReset(CODEX_LIMIT_BARE_CLOCK, now);
    expect(resetsAt).not.toBeNull();
    expect(resetsAt?.getDate()).toBe(7);
    expect(resetsAt?.getHours()).toBe(15);
    expect(resetsAt?.getMinutes()).toBe(27);
  });

  it('rolls a codex bare-clock time already past to the next day', () => {
    const evening = new Date('2026-08-07T22:00:00');
    const resetsAt = parseUsageLimitReset(CODEX_LIMIT_BARE_CLOCK, evening);
    expect(resetsAt?.getDate()).toBe(8);
    expect(resetsAt?.getHours()).toBe(15);
    expect(resetsAt?.getMinutes()).toBe(27);
  });

  it('parses the codex relative reset', () => {
    const resetsAt = parseUsageLimitReset(CODEX_LIMIT_RELATIVE, now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + ((5 * 24 + 22) * 60 + 11) * 60_000);
  });

  it('parses the Claude same-day reset clock time', () => {
    const resetsAt = parseUsageLimitReset(CLAUDE_SESSION_LIMIT, now);
    expect(resetsAt?.getDate()).toBe(7);
    expect(resetsAt?.getHours()).toBe(15);
    expect(resetsAt?.getMinutes()).toBe(45);
  });

  it("accepts the 'resets at <clock>' phrasing", () => {
    const resetsAt = parseUsageLimitReset("You've hit your session limit · resets at 3:45pm", now);
    expect(resetsAt?.getDate()).toBe(7);
    expect(resetsAt?.getHours()).toBe(15);
    expect(resetsAt?.getMinutes()).toBe(45);
  });

  it('rolls a Claude clock time already past to the next day', () => {
    const evening = new Date('2026-08-07T22:00:00');
    const resetsAt = parseUsageLimitReset(CLAUDE_SESSION_LIMIT, evening);
    expect(resetsAt?.getDate()).toBe(8);
    expect(resetsAt?.getHours()).toBe(15);
  });

  it('parses the Claude weekly reset to the named weekday', () => {
    // 2026-08-07 is a Friday; "resets Mon 12:00am" lands on Monday the 10th.
    const resetsAt = parseUsageLimitReset(CLAUDE_WEEKLY_LIMIT, now);
    expect(resetsAt?.getDay()).toBe(1);
    expect(resetsAt?.getDate()).toBe(10);
    expect(resetsAt?.getHours()).toBe(0);
  });

  it('parses the legacy Claude epoch suffix', () => {
    const resetsAt = parseUsageLimitReset('Claude AI usage limit reached|1754642820', now);
    expect(resetsAt?.getTime()).toBe(1754642820_000);
  });

  it('parses the antigravity compact reset duration', () => {
    const resetsAt = parseUsageLimitReset(ANTIGRAVITY_QUOTA, now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + ((2 * 60 + 6) * 60 + 30) * 1000);
  });

  it('parses the Groq fractional-seconds retry hint', () => {
    const resetsAt = parseUsageLimitReset(GROQ_RATE_LIMIT, now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + 7660);
  });

  it('parses the appended Retry-After suffix', () => {
    const resetsAt = parseUsageLimitReset('HTTP 429 (retry-after: 60s)', now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('reads a named IANA zone in that zone, not the local one', () => {
    // Europe/Warsaw is UTC+2 in August, so 4pm there is 14:00Z.
    const morning = new Date('2026-08-07T06:00:00Z');
    const resetsAt = parseUsageLimitReset(
      "You've hit your session limit · resets 4pm (Europe/Warsaw)",
      morning,
    );
    expect(resetsAt?.toISOString()).toBe('2026-08-07T14:00:00.000Z');
  });

  it('rolls a zoned clock time already past to the next day', () => {
    const evening = new Date('2026-08-07T20:00:00Z');
    const resetsAt = parseUsageLimitReset(
      "You've hit your session limit · resets 4pm (Europe/Warsaw)",
      evening,
    );
    expect(resetsAt?.toISOString()).toBe('2026-08-08T14:00:00.000Z');
  });

  it('parses a bare Retry-After header delay in seconds', () => {
    const resetsAt = parseUsageLimitReset('HTTP 429 (retry-after: 120)', now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + 120_000);
  });

  it('parses a Retry-After header carrying an HTTP date', () => {
    const resetsAt = parseUsageLimitReset(
      'HTTP 429 rate limit exceeded; retry-after: Wed, 21 Oct 2026 07:28:00 GMT',
      now,
    );
    expect(resetsAt?.toISOString()).toBe('2026-10-21T07:28:00.000Z');
  });

  it('returns null when the message names no reset', () => {
    expect(parseUsageLimitReset('Credit balance is too low', now)).toBeNull();
    expect(parseUsageLimitReset(ANTHROPIC_RATE_LIMIT_BODY, now)).toBeNull();
  });
});

describe('parseUsageLimitReset without a clock of its own', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A clock-relative reset reads the one clock every reset surface reads.
  it('reads "now" from Date.now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 13, 16, 0).getTime());

    expect(parseUsageLimitReset('usage limit reached · resets 5pm')).toEqual(
      new Date(2026, 6, 13, 17, 0),
    );
  });
});
