import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { redactRunnerCallWarningInput } from './redact-event.js';
import { RunnerCallEventSchema, RunnerCallWarningSchema } from './schema.js';
import type { RunnerCallWarningInput } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

describe('RunnerCallWarningSchema usage', () => {
  it('parses a warning with usage through normalizeRunnerCallWarning', () => {
    const warning = normalizeRunnerCallWarning({
      code: 'claude_rate_limit',
      message: "You've used 75% of your Claude 5-hour limit",
      usage: {
        window: 'five_hour',
        step: 75,
        resetsAt: 1_770_000_000_000,
      },
    });

    expect(warning.usage).toEqual({
      window: 'five_hour',
      step: 75,
      resetsAt: 1_770_000_000_000,
    });
  });

  it('parses a warning with usage without resetsAt', () => {
    const warning = normalizeRunnerCallWarning({
      code: 'claude_rate_limit',
      message: "You've used 90% of your Claude weekly limit",
      usage: {
        window: 'seven_day',
        step: 90,
      },
    });

    expect(warning.usage).toEqual({
      window: 'seven_day',
      step: 90,
    });
  });

  it('rejects an unknown window in normalizeRunnerCallWarning', () => {
    expect(() =>
      normalizeRunnerCallWarning({
        code: 'claude_rate_limit',
        message: 'Rate limit hit',
        usage: {
          window: 'unknown_window' as unknown as 'five_hour',
          step: 75,
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown window in RunnerCallWarningSchema', () => {
    const result = RunnerCallWarningSchema.safeParse({
      code: 'claude_rate_limit',
      message: 'Rate limit hit',
      usage: {
        window: 'daily',
        step: 75,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer step or negative resetsAt or extra properties', () => {
    expect(
      RunnerCallWarningSchema.safeParse({
        code: 'claude_rate_limit',
        message: 'Rate limit hit',
        usage: {
          window: 'five_hour',
          step: 75.5,
        },
      }).success,
    ).toBe(false);

    expect(
      RunnerCallWarningSchema.safeParse({
        code: 'claude_rate_limit',
        message: 'Rate limit hit',
        usage: {
          window: 'five_hour',
          step: 75,
          resetsAt: -1,
        },
      }).success,
    ).toBe(false);

    expect(
      RunnerCallWarningSchema.safeParse({
        code: 'claude_rate_limit',
        message: 'Rate limit hit',
        usage: {
          window: 'five_hour',
          step: 75,
          extra: true,
        },
      }).success,
    ).toBe(false);
  });

  it('parses a warning with usage through the events schema', () => {
    const event = {
      type: 'runner_call_warning',
      ts: 1_000,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      warning: {
        code: 'claude_rate_limit',
        message: "You've used 75% of your Claude 5-hour limit",
        usage: {
          window: 'five_hour',
          step: 75,
          resetsAt: 1_770_000_000_000,
        },
      },
    };

    const parsed = EngineEventSchema.parse(event);
    expect(parsed).toMatchObject({
      type: 'runner_call_warning',
      warning: expect.objectContaining({
        usage: {
          window: 'five_hour',
          step: 75,
          resetsAt: 1_770_000_000_000,
        },
      }),
    });
  });

  it('rejects an unknown window through the events schema', () => {
    const invalidEvent = {
      type: 'runner_call_warning',
      ts: 1_000,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      warning: {
        code: 'claude_rate_limit',
        message: 'Rate limit hit',
        usage: {
          window: 'unknown_window',
          step: 75,
        },
      },
    };

    expect(() => EngineEventSchema.parse(invalidEvent)).toThrow();
  });

  it('parses a call_warning event with usage and rejects an unknown window', () => {
    const callEvent = {
      type: 'call_warning',
      ts: 1_000,
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      warning: {
        code: 'claude_rate_limit',
        message: "You've used 80% of your Claude weekly limit",
        usage: {
          window: 'seven_day',
          step: 80,
        },
      },
    };

    const parsed = RunnerCallEventSchema.parse(callEvent);
    expect(parsed).toMatchObject({
      type: 'call_warning',
      warning: expect.objectContaining({
        usage: {
          window: 'seven_day',
          step: 80,
        },
      }),
    });

    expect(() =>
      RunnerCallEventSchema.parse({
        ...callEvent,
        warning: {
          ...callEvent.warning,
          usage: {
            window: 'unknown_window',
            step: 80,
          },
        },
      }),
    ).toThrow();
  });

  it('keeps usage unchanged through redactRunnerCallWarningInput', () => {
    const input: RunnerCallWarningInput = {
      code: 'claude_rate_limit',
      message: 'warning with secret secret_key_123',
      usage: {
        window: 'five_hour',
        step: 75,
        resetsAt: 1_770_000_000_000,
      },
    };

    const redacted = redactRunnerCallWarningInput(input, (text) =>
      text.replaceAll('secret_key_123', '[REDACTED]'),
    );

    expect(redacted.usage).toEqual({
      window: 'five_hour',
      step: 75,
      resetsAt: 1_770_000_000_000,
    });
    expect(redacted.message).toBe('warning with secret [REDACTED]');
    expect(redacted.redacted).toBe(true);
  });
});
