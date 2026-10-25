import { describe, expect, it } from 'vitest';
import { formatUsageLimitWarning } from '../../core/recovery/usage-limit-step.js';
import { parseStreamLine } from './parse-stream-json.js';

function rateLimitLine(info: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'rate_limit_event',
    session_id: 'sess-rate',
    rate_limit_info: info,
  });
}

describe('parseStreamLine rate limit events', () => {
  it('emits a stepped warning for both windows when both cross', () => {
    const line = rateLimitLine({
      status: 'allowed_warning',
      unifiedWindows: {
        five_hour: { utilization: 0.72, resetsAt: 1790971200 },
        seven_day: { utilization: 0.86, resetsAt: 1791450000 },
      },
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step: 70,
          tool: 'Claude Code',
          window: 'five_hour',
          resetsAt: 1790971200 * 1000,
        }),
        usage: {
          window: 'five_hour',
          step: 70,
          resetsAt: 1790971200 * 1000,
        },
      },
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step: 85,
          tool: 'Claude Code',
          window: 'seven_day',
          resetsAt: 1791450000 * 1000,
        }),
        usage: {
          window: 'seven_day',
          step: 85,
          resetsAt: 1791450000 * 1000,
        },
      },
    ]);
  });

  it('emits no warning when utilization is below 70 percent', () => {
    const line = rateLimitLine({
      status: 'allowed_warning',
      unifiedWindows: {
        five_hour: { utilization: 0.54, resetsAt: 1790971200 },
        seven_day: { utilization: 0.69, resetsAt: 1791450000 },
      },
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toBeUndefined();
  });

  it('emits the highest reached step on a jump over two steps', () => {
    const line = rateLimitLine({
      status: 'allowed_warning',
      unifiedWindows: {
        five_hour: { utilization: 0.82, resetsAt: 1790971200 },
      },
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step: 80,
          tool: 'Claude Code',
          window: 'five_hour',
          resetsAt: 1790971200 * 1000,
        }),
        usage: {
          window: 'five_hour',
          step: 80,
          resetsAt: 1790971200 * 1000,
        },
      },
    ]);
  });

  it('emits no warning for a window at 100 percent', () => {
    const line = rateLimitLine({
      status: 'rejected',
      unifiedWindows: {
        five_hour: { utilization: 1.0, resetsAt: 1790971200 },
        seven_day: { utilization: 0.8, resetsAt: 1791450000 },
      },
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step: 80,
          tool: 'Claude Code',
          window: 'seven_day',
          resetsAt: 1791450000 * 1000,
        }),
        usage: {
          window: 'seven_day',
          step: 80,
          resetsAt: 1791450000 * 1000,
        },
      },
    ]);
  });

  it('emits no warning for a frame with no unifiedWindows', () => {
    const line = rateLimitLine({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      resetsAt: 1791450000,
      utilization: 0.85,
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toBeUndefined();
  });

  it('emits a warning for an allowed frame at 80 percent', () => {
    const line = rateLimitLine({
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.8, resetsAt: 1790971200 },
      },
    });
    const parsed = parseStreamLine(line);

    expect(parsed.isHeartbeat).toBe(true);
    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step: 80,
          tool: 'Claude Code',
          window: 'five_hour',
          resetsAt: 1790971200 * 1000,
        }),
        usage: {
          window: 'five_hour',
          step: 80,
          resetsAt: 1790971200 * 1000,
        },
      },
    ]);
  });
});
