import { describe, expect, it } from 'vitest';
import {
  USAGE_LIMIT_STEPS,
  USAGE_LIMIT_WINDOWS,
  formatUsageLimitWarning,
  usageLimitStep,
} from './usage-limit-step.js';

function localTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('usageLimitStep exports', () => {
  it('exports the usage limit steps and windows', () => {
    expect(USAGE_LIMIT_STEPS).toEqual([70, 75, 80, 85, 90, 95]);
    expect(USAGE_LIMIT_WINDOWS).toEqual(['five_hour', 'seven_day']);
  });
});

describe('usageLimitStep', () => {
  it('returns null below 70', () => {
    expect(usageLimitStep(69)).toBeNull();
    expect(usageLimitStep(69.9)).toBeNull();
    expect(usageLimitStep(50)).toBeNull();
    expect(usageLimitStep(0)).toBeNull();
    expect(usageLimitStep(-5)).toBeNull();
  });

  it('returns the exact step at each step boundary', () => {
    expect(usageLimitStep(70)).toBe(70);
    expect(usageLimitStep(75)).toBe(75);
    expect(usageLimitStep(80)).toBe(80);
    expect(usageLimitStep(85)).toBe(85);
    expect(usageLimitStep(90)).toBe(90);
    expect(usageLimitStep(95)).toBe(95);
  });

  it('returns the highest step at or below values between steps', () => {
    expect(usageLimitStep(71)).toBe(70);
    expect(usageLimitStep(74.9)).toBe(70);
    expect(usageLimitStep(77)).toBe(75);
    expect(usageLimitStep(82)).toBe(80);
    expect(usageLimitStep(88)).toBe(85);
    expect(usageLimitStep(92)).toBe(90);
    expect(usageLimitStep(99)).toBe(95);
  });

  it('returns null at or above 100', () => {
    expect(usageLimitStep(100)).toBeNull();
    expect(usageLimitStep(100.1)).toBeNull();
    expect(usageLimitStep(105)).toBeNull();
  });
});

describe('formatUsageLimitWarning', () => {
  it('formats warning for both windows without a reset', () => {
    expect(formatUsageLimitWarning({ step: 70, tool: 'Claude Code', window: 'five_hour' })).toBe(
      "You've used 70% of your Claude Code 5-hour limit",
    );
    expect(formatUsageLimitWarning({ step: 85, tool: 'Claude Code', window: 'seven_day' })).toBe(
      "You've used 85% of your Claude Code weekly limit",
    );
  });

  it('formats warning with a dated reset', () => {
    const resetsAt = localTime(2026, 7, 13, 9, 5);
    expect(
      formatUsageLimitWarning({ step: 70, tool: 'Claude Code', window: 'five_hour', resetsAt }),
    ).toBe("You've used 70% of your Claude Code 5-hour limit · resets Jul 13, 09:05");
    expect(
      formatUsageLimitWarning({ step: 85, tool: 'Claude Code', window: 'seven_day', resetsAt }),
    ).toBe("You've used 85% of your Claude Code weekly limit · resets Jul 13, 09:05");
  });

  it('formats a weekly warning with a dated reset from object options', () => {
    const resetsAt = localTime(2026, 9, 29, 23, 59);
    expect(
      formatUsageLimitWarning({ step: 80, tool: 'Claude Code', window: 'seven_day', resetsAt }),
    ).toBe("You've used 80% of your Claude Code weekly limit · resets Sep 29, 23:59");
  });
});
