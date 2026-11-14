import { describe, expect, it } from 'vitest';
import { HALT_SIGNATURES } from '../../../core/pipeline-spec/halts.js';
import { isUsageLimitDiagnostic, usageLimitAdvice } from './usage-limit.js';
import { parseUsageLimitReset } from './reset-time.js';
import { isAuthFailureDiagnostic } from './auth.js';
import { classifySeatFailure } from './classify.js';
import { codexImplementerAdapter } from '../cli-tools/codex/adapter.js';
import { claudeProtocolEvents } from '../cli-tools/claude-code/protocol.js';
import {
  opencodeImplementerAdapter,
  opencodeProtocolEvents,
} from '../cli-tools/opencode/adapter.js';
import { kiloPlannerAdapter, kiloPlannerProtocolEvents } from '../cli-tools/kilo-code.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  ANTHROPIC_RATE_LIMIT_BODY,
  ANTIGRAVITY_QUOTA,
  CLAUDE_SESSION_LIMIT,
  CLAUDE_WEEKLY_LIMIT,
  CODEX_LIMIT_MESSAGE,
  CODEX_LIMIT_RELATIVE,
  GROQ_RATE_LIMIT,
} from '#testing/helpers/usage-limit-fixtures.js';

/** An OpenCode stream that ends on its error line: the line is the call's terminal. */
function opencodeTerminal(line: string) {
  return opencodeImplementerAdapter.terminal({
    outputContract: opencodeImplementerAdapter.outputContract,
    events: opencodeProtocolEvents(line),
    stderr: '',
    exitCode: 1,
    signal: null,
  });
}

const CODEX_LIMIT_RECORDS = [
  `{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM."}`,
  `{"type":"turn.failed","error":{"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM."}}`,
];

const CLAUDE_OPUS_LIMIT = "You've hit your Opus limit · resets 3:45pm";
const CLAUDE_429 =
  'API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.';
// Captured from a real Claude Code 2.1.206 session transcript (2026-07-11).
const CLAUDE_MODEL_LIMIT =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

const OPENAI_QUOTA =
  '429 You exceeded your current quota, please check your plan and billing details.';
// The documented Gemini API 429 body.
const GEMINI_RESOURCE_EXHAUSTED =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}';

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
    ANTIGRAVITY_QUOTA,
    GEMINI_RESOURCE_EXHAUSTED,
    'You have exhausted your capacity on this model.',
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
    'update your billing address',
    'implements a rate limit',
  ])('does not classify %j as a limit', (message) => {
    expect(isUsageLimitDiagnostic(message)).toBe(false);
  });

  it('every HALT_SIGNATURES.usage phrase classifies as a usage limit', () => {
    for (const phrase of HALT_SIGNATURES.usage) {
      expect(isUsageLimitDiagnostic(`CLI failed: ${phrase}`)).toBe(true);
    }
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
      ANTIGRAVITY_QUOTA,
    ]) {
      expect(isAuthFailureDiagnostic(message)).toBe(false);
    }
  });
});

describe('usageLimitAdvice', () => {
  // The sentence is stored and replayed on later days; the surfaces spell the reset from `resetAt`.
  it('names the menu action for the seat and no clock, never a login', () => {
    const advice = usageLimitAdvice({ tool: 'OpenAI Codex CLI', seat: 'build' });

    expect(advice).toBe(
      'OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the BUILD tool, then continue.',
    );
    expect(advice).not.toMatch(/log ?in|log ?out/i);
  });

  it('names the seat the halt stopped on', () => {
    expect(usageLimitAdvice({ tool: 'Ollama', seat: 'plan' })).toBe(
      'Ollama hit its usage limit. Wait for the limit to reset or change the PLAN tool, then continue.',
    );
  });
});

describe('end-to-end classification of the live codex limit records', () => {
  it('parses, terminates, and classifies the verbatim records as usage-limit', () => {
    const events = CODEX_LIMIT_RECORDS.flatMap((line) => codexImplementerAdapter.parse(line));
    const terminal = codexImplementerAdapter.terminal({
      outputContract: codexImplementerAdapter.outputContract,
      events,
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
    const kiloTerminal = kiloPlannerAdapter.terminal({
      outputContract: kiloPlannerAdapter.outputContract,
      events: kiloPlannerProtocolEvents(line),
      stderr: '',
      exitCode: 1,
      signal: null,
    });
    for (const terminal of [opencodeTerminal(line), kiloTerminal]) {
      expect(terminal?.type).toBe('result');
      if (terminal?.type !== 'result') continue;
      expect(terminal.error?.message).toBe('APIError: Rate limit exceeded');
      expect(isUsageLimitDiagnostic(terminal.error?.message ?? '')).toBe(true);
    }
  });

  it('classifies the flat OpenCode 2.0.12 quota envelope as usage-limit', () => {
    // Captured live from `opencode run --standalone --format json` on 2026-09-21
    // (OpenCode Go at its limit); on a live run the fallback message hid it and
    // the ladder burned every retry on `opencode-error`.
    const line =
      '{"type":"error","timestamp":1790016994502,"sessionID":"ses_f3aac4834ffexQ7jY8OG1Vw3Ox","error":{"type":"provider.quota","message":"Go usage limit exceeded","status":429}}';
    const terminal = opencodeTerminal(line);
    expect(terminal.error?.message).toBe('provider.quota: Go usage limit exceeded');
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: terminal.text,
        error: terminal.error ?? { code: 'opencode-error', message: 'OpenCode reported an error' },
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
  });
});

// Captured live from `agy -p` (antigravity 1.2.7) on 2026-09-21: the retry after
// the exit-0 hit, beside exit 3 and without the truncation suffix.
const ANTIGRAVITY_QUOTA_EXIT_3 =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h3m48s.';
// The diagnostic `opencodeProtocolEvents` derives from the 2.0.12 `provider.quota`
// envelope; the envelope itself runs end-to-end in the describe above.
const OPENCODE_QUOTA_MESSAGE = 'provider.quota: Go usage limit exceeded';
// Captured live from `codex exec --json` on 2026-09-21 (the `error` record; the
// `turn.failed` record that follows carries the same message).
const CODEX_LIMIT_MESSAGE_2026_09_21 =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 24th, 2026 6:20 PM.";
// Captured live from `cmd` (command-code) on 2026-09-21: the `run_error` event
// message, then the `result.error` string of the same run.
const COMMAND_CODE_RUN_ERROR =
  "POST /alpha/generate → 429 error: You've reached your weekly usage limit for your plan. Your limit resets at 2026-09-23T15:50:48.385Z. Please wait for the window to reset or upgrade your plan to continue.";
const COMMAND_CODE_RESULT_ERROR =
  "Error: You've reached your weekly usage limit. Resets in 2d 1h (Wed 5:50 PM). Run /upgrade for a higher plan or /extra for on-demand credits.";
// The documented Gemini API 429 body, serialized as the diagnostic.
const GEMINI_QUOTA_METRIC_BODY =
  '{"error":{"code":429,"message":"Quota exceeded for quota metric \'Generate Content API requests per minute\'","status":"RESOURCE_EXHAUSTED"}}';

describe("every tool's captured limit line classifies usage-limit", () => {
  // Copilot has no row: its quota wording was never captured (the probe account
  // was policy-denied), so nothing here vouches for it.
  it.each([
    ['antigravity stderr beside exit 0', ANTIGRAVITY_QUOTA],
    ['antigravity stderr beside exit 3', ANTIGRAVITY_QUOTA_EXIT_3],
    ['opencode 2.0.12 provider.quota envelope', OPENCODE_QUOTA_MESSAGE],
    ['codex error record', CODEX_LIMIT_MESSAGE_2026_09_21],
    ['command-code run_error', COMMAND_CODE_RUN_ERROR],
    ['command-code result.error', COMMAND_CODE_RESULT_ERROR],
    ['Gemini API RESOURCE_EXHAUSTED body', GEMINI_QUOTA_METRIC_BODY],
    ['Claude Code result text', CLAUDE_SESSION_LIMIT],
  ])('%s', (_family, line) => {
    expect(isUsageLimitDiagnostic(line)).toBe(true);
    expect(isAuthFailureDiagnostic(line)).toBe(false);
  });
});

// Recorded on 2026-10-05 (run 2026-10-05-s6-central-checks-and-renders-plus-the-carried-in--2,
// `runner_call_error` of implementer-1): opencode with `deepseek/deepseek-flash` on a spent
// DeepSeek account. The run retried it once and consulted the planner on it.
const OPENCODE_DEEPSEEK_BALANCE =
  'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';

describe('an account the provider will not bill is a seat-down limit', () => {
  it('classifies the recorded opencode balance refusal as usage-limit with no reset to wait for', () => {
    expect(isUsageLimitDiagnostic(OPENCODE_DEEPSEEK_BALANCE)).toBe(true);
    expect(isAuthFailureDiagnostic(OPENCODE_DEEPSEEK_BALANCE)).toBe(false);
    expect(parseUsageLimitReset(OPENCODE_DEEPSEEK_BALANCE)).toBeNull();
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'opencode-error', message: OPENCODE_DEEPSEEK_BALANCE },
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
  });

  it.each([
    'Insufficient Balance',
    '402 Payment Required',
    'HTTP 402: account suspended',
    'unexpected status 402',
    '{"error":{"message":"account suspended"},"status":402}',
    'Error code: 429 - insufficient_quota',
    'billing_hard_limit_reached: You have reached your billing hard limit.',
    'billing_not_active: Your account is not active, please check your billing details.',
    'This request requires more credits, or fewer max_tokens.',
  ])('classifies %j as usage-limit, not auth', (message) => {
    expect(isUsageLimitDiagnostic(message)).toBe(true);
    expect(isAuthFailureDiagnostic(message)).toBe(false);
  });

  it('reads a provider 402 as an account refusal even when its body names no known phrase', () => {
    expect(
      classifySeatFailure({
        message: '{"error":{"message":"Account on hold"}}',
        status: 402,
        source: 'thrown',
      }),
    ).toEqual({ class: 'account', cause: 'balance' });
  });
});
