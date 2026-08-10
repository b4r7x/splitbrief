import { describe, expect, it } from 'vitest';
import {
  formatUsageLimitReset,
  isUsageLimitDiagnostic,
  parseUsageLimitReset,
  usageLimitDetailFromError,
  usageLimitGuidance,
} from './usage-limit.js';
import { isAuthFailureDiagnostic } from './auth-failure.js';
import { codexImplementerAdapter } from './cli-tools/codex.js';
import { claudeProtocolEvents } from './cli-tools/claude-code.js';
import { opencodeProtocolEvents } from './cli-tools/opencode.js';
import { kiloPlannerProtocolEvents } from './cli-tools/kilo-code.js';
import { runnerCallOutcome } from '../implementers/pipeline/call-result.js';
import { streamError } from '../streaming/stream-errors.js';
import { error } from '../../utils/error.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';

// Captured live from `codex exec --json` on 2026-08-06 against an account at
// its usage limit; the same message arrives back-to-back as an `error` record
// and a `turn.failed` record.
const CODEX_LIMIT_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";
const CODEX_LIMIT_BARE_CLOCK =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:27 PM.";
const CODEX_LIMIT_RECORDS = [
  `{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM."}`,
  `{"type":"turn.failed","error":{"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM."}}`,
];
// The Plus/Pro variant of the same limit (openai/codex#3899).
const CODEX_LIMIT_RELATIVE =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 5 days 22 hours 11 minutes.";

// Verbatim strings from the Claude Code error reference
// (code.claude.com/docs/en/errors); they arrive as `is_error` result text.
const CLAUDE_SESSION_LIMIT = "You've hit your session limit · resets 3:45pm";
const CLAUDE_WEEKLY_LIMIT = "You've hit your weekly limit · resets Mon 12:00am";
const CLAUDE_OPUS_LIMIT = "You've hit your Opus limit · resets 3:45pm";
const CLAUDE_429 =
  'API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.';
// Captured from a real Claude Code 2.1.206 session transcript (2026-07-11).
const CLAUDE_MODEL_LIMIT =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
const ANTHROPIC_RATE_LIMIT_BODY =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CcuTLfeewCy8ujAVGd6Ws"}';

const OPENAI_QUOTA =
  '429 You exceeded your current quota, please check your plan and billing details.';
const GROQ_RATE_LIMIT =
  'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per minute (TPM). Please try again in 7.66s.';

describe('isUsageLimitDiagnostic', () => {
  it.each([
    CODEX_LIMIT_MESSAGE,
    CODEX_LIMIT_RELATIVE,
    CLAUDE_SESSION_LIMIT,
    CLAUDE_WEEKLY_LIMIT,
    CLAUDE_OPUS_LIMIT,
    CLAUDE_429,
    CLAUDE_MODEL_LIMIT,
    'Claude AI usage limit reached|1754642820',
    'Credit balance is too low',
    ANTHROPIC_RATE_LIMIT_BODY,
    OPENAI_QUOTA,
    GROQ_RATE_LIMIT,
    'APIError: Rate limit exceeded',
  ])('recognizes %j', (message) => {
    expect(isUsageLimitDiagnostic(message)).toBe(true);
  });

  it.each([
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Invalid API key · Please run /login',
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    'Codex turn failed',
    'Overloaded: please retry',
    'tsc exited with code 2: src/main.ts(3,1): error TS2304',
    'vitest: 429 tests passed',
    'Added rate limit handling to src/api/client.ts',
  ])('does not classify %j as a limit', (message) => {
    expect(isUsageLimitDiagnostic(message)).toBe(false);
  });

  it.each(['HTTP 429 Too Many Requests'])('corroborates weak 429 signals for %j', (message) => {
    expect(isUsageLimitDiagnostic(message)).toBe(true);
  });

  it('never overlaps with the auth classifier on the real limit shapes', () => {
    for (const message of [
      CODEX_LIMIT_MESSAGE,
      CLAUDE_SESSION_LIMIT,
      CLAUDE_MODEL_LIMIT,
      'Credit balance is too low',
    ]) {
      expect(isAuthFailureDiagnostic(message)).toBe(false);
    }
  });
});

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
    expect(formatUsageLimitReset(resetsAt as Date)).toBe('Aug 8, 2026, 3:27 PM');
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

  it('parses the Groq fractional-seconds retry hint', () => {
    const resetsAt = parseUsageLimitReset(GROQ_RATE_LIMIT, now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + 7660);
  });

  it('parses the appended Retry-After suffix', () => {
    const resetsAt = parseUsageLimitReset('HTTP 429 (retry-after: 60s)', now);
    expect(resetsAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('returns null when the message names no reset', () => {
    expect(parseUsageLimitReset('Credit balance is too low', now)).toBeNull();
    expect(parseUsageLimitReset(ANTHROPIC_RATE_LIMIT_BODY, now)).toBeNull();
  });
});

describe('usageLimitGuidance', () => {
  it('names the reset when known and never suggests logging in', () => {
    const guidance = usageLimitGuidance(new Date('2026-08-08T15:27:00'));
    expect(guidance).toBe(
      'The limit resets at Aug 8, 2026, 3:27 PM; wait for it, switch to a different runner profile, or abort.',
    );
    expect(guidance).not.toMatch(/log ?in|log ?out/i);
  });

  it('still offers the real options when the reset is unknown', () => {
    expect(usageLimitGuidance(null)).toBe(
      'Wait for the limit to reset, switch to a different runner profile, or abort.',
    );
  });
});

describe('usageLimitDetailFromError', () => {
  it('reads the raw 429 detail from a mapped provider stream error', () => {
    const err = streamError.httpStatus('openrouter', 429, OPENAI_QUOTA);
    expect(usageLimitDetailFromError(err)).toBe(OPENAI_QUOTA);
  });

  it('classifies a bare 429 status even when the body matches no phrase', () => {
    const err = streamError.httpStatus('together', 429, 'slow down');
    expect(usageLimitDetailFromError(err)).toBe('slow down');
  });

  it('reads the nested runner-call error a failed planner call carries', () => {
    const err = error('runner-call-failed', 'Planner planner call failed', {
      error: { code: 'codex-turn-failed', message: CODEX_LIMIT_MESSAGE },
    });
    expect(usageLimitDetailFromError(err)).toBe(CODEX_LIMIT_MESSAGE);
  });

  it('returns null for non-limit errors', () => {
    expect(usageLimitDetailFromError(streamError.httpStatus('deepseek', 401, 'Unauthorized'))).toBe(
      null,
    );
    expect(usageLimitDetailFromError(new Error('connection failed'))).toBeNull();
  });
});

describe('end-to-end classification of the live codex limit records', () => {
  it('parses, terminates, and classifies the verbatim records as usage-limit', () => {
    const events = CODEX_LIMIT_RECORDS.flatMap((line) => codexImplementerAdapter.parse(line));
    const terminal = codexImplementerAdapter.terminal({
      outputContract: codexImplementerAdapter.outputContract,
      events,
      stdout: CODEX_LIMIT_RECORDS.join('\n'),
      stderr: '',
      exitCode: 1,
      signal: null,
    });
    expect(terminal.status).toBe('failed');
    expect(terminal.error?.message).toBe(CODEX_LIMIT_MESSAGE);

    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: terminal.text,
        error: terminal.error ?? { code: 'codex-turn-failed', message: CODEX_LIMIT_MESSAGE },
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
    expect(outcome.remediation).not.toMatch(/log ?in|log ?out|authenticate/i);
  });

  it('classifies the Claude Code limit result text as usage-limit', () => {
    const line = JSON.stringify({
      type: 'result',
      result: CLAUDE_SESSION_LIMIT,
      is_error: true,
      session_id: 'sess-limit',
    });
    const terminal = claudeProtocolEvents(line).find((event) => event.type === 'result');
    expect(terminal?.type).toBe('result');
    if (terminal?.type !== 'result') return;
    expect(terminal.error?.message).toBe(CLAUDE_SESSION_LIMIT);
  });

  it('keeps the provider message from an OpenCode error envelope so limits classify', () => {
    const line = JSON.stringify({
      type: 'error',
      sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
      error: {
        name: 'APIError',
        data: { message: 'Rate limit exceeded', statusCode: 429, isRetryable: true },
      },
    });
    for (const parse of [opencodeProtocolEvents, kiloPlannerProtocolEvents]) {
      const terminal = parse(line).find((event) => event.type === 'result');
      expect(terminal?.type).toBe('result');
      if (terminal?.type !== 'result') continue;
      expect(terminal.error?.message).toBe('APIError: Rate limit exceeded');
      expect(isUsageLimitDiagnostic(terminal.error?.message ?? '')).toBe(true);
    }
  });
});
