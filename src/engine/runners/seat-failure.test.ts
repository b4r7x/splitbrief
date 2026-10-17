import { describe, expect, it } from 'vitest';
import { classifyHaltSignature } from '../../core/pipeline-spec/halts.js';
import { runnerCallOutcome } from '../implementers/pipeline/call-result.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { opencodePlannerAdapter, opencodeProtocolEvents } from './cli-tools/opencode.js';
import { classifySeatFailure, type SeatFailureInput } from './seat-failure.js';

/** The classification as one comparable word, so a row reads at a glance. */
function label(classification: ReturnType<typeof classifySeatFailure>): string {
  return classification.class === 'account'
    ? `account:${classification.cause}`
    : classification.class;
}

type Row = Readonly<{
  name: string;
  provenance: 'captured' | 'synthetic';
  input: SeatFailureInput;
  expected: string;
}>;

// Captured live from `codex exec --json` (2026-08-06) against an account at its usage limit.
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";
// Captured verbatim from `codex exec --json` (codex-cli 0.146.0, 2026-08-06) on a rotated refresh token.
const CODEX_BURNED_REFRESH =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
// Verbatim strings from the Claude Code error reference; they arrive as `is_error` result text.
const CLAUDE_SESSION_LIMIT = "You've hit your session limit · resets 3:45pm";
const CLAUDE_WEEKLY_LIMIT = "You've hit your weekly limit · resets Mon 12:00am";
const CLAUDE_OPUS_LIMIT = "You've hit your Opus limit · resets 3:45pm";
const CLAUDE_429 =
  'API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.';
const ANTHROPIC_RATE_LIMIT_BODY =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CcuTLfeewCy8ujAVGd6Ws"}';
const OPENAI_QUOTA =
  '429 You exceeded your current quota, please check your plan and billing details.';
const GEMINI_RESOURCE_EXHAUSTED =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}';
// Captured live from `opencode run --standalone --format json` (OpenCode Go at its limit, 2026-09-21).
const OPENCODE_GO_LIMIT = 'provider.quota: Go usage limit exceeded';
// Recorded on 2026-10-05: opencode with `deepseek/deepseek-flash` on a spent DeepSeek account.
const OPENCODE_DEEPSEEK_BALANCE =
  'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';
// Recorded on 2026-10-17: opencode with `ollama-cloud/deepseek-v4.1-flash` and no Ollama Cloud credential.
const OPENCODE_NO_ROUTE = 'provider.no-route: Model unavailable: ollama-cloud/deepseek-v4.1-flash';
// Captured live from `agy -p` (antigravity 1.2.7) on 2026-09-21, on stderr.
const ANTIGRAVITY_QUOTA =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)';
// Captured live from `cmd` (command-code) on 2026-09-21.
const COMMAND_CODE_RUN_ERROR =
  "POST /alpha/generate → 429 error: You've reached your weekly usage limit for your plan. Your limit resets at 2026-09-23T15:50:48.385Z. Please wait for the window to reset or upgrade your plan to continue.";

const ENVELOPES: readonly Row[] = [
  {
    name: 'opencode Go usage limit (provider.quota, 429)',
    provenance: 'captured',
    input: {
      message: OPENCODE_GO_LIMIT,
      status: 429,
      providerType: 'provider.quota',
      source: 'result-error',
    },
    expected: 'account:quota',
  },
  {
    name: 'opencode DeepSeek insufficient balance',
    provenance: 'captured',
    input: {
      message: OPENCODE_DEEPSEEK_BALANCE,
      providerType: 'provider.quota',
      source: 'result-error',
    },
    expected: 'account:balance',
  },
  {
    name: 'opencode route refusal (provider.no-route) is not a sign-out on its own',
    provenance: 'captured',
    input: {
      message: OPENCODE_NO_ROUTE,
      providerType: 'provider.no-route',
      source: 'result-error',
    },
    expected: 'other',
  },
  {
    name: 'codex usage limit with an absolute reset',
    provenance: 'captured',
    input: { message: CODEX_USAGE_LIMIT, source: 'result-error' },
    expected: 'rate-limited',
  },
  {
    name: 'codex burned refresh token',
    provenance: 'captured',
    input: { message: CODEX_BURNED_REFRESH, source: 'result-error' },
    expected: 'account:auth',
  },
  {
    name: 'claude-code session limit',
    provenance: 'captured',
    input: { message: CLAUDE_SESSION_LIMIT, source: 'result-error' },
    expected: 'rate-limited',
  },
  {
    name: 'claude-code weekly limit',
    provenance: 'captured',
    input: { message: CLAUDE_WEEKLY_LIMIT, source: 'result-error' },
    expected: 'rate-limited',
  },
  {
    name: 'claude-code Opus limit',
    provenance: 'captured',
    input: { message: CLAUDE_OPUS_LIMIT, source: 'result-error' },
    expected: 'rate-limited',
  },
  {
    name: 'claude-code request rejected (429) is a capacity retry',
    provenance: 'captured',
    input: { message: CLAUDE_429, source: 'result-error' },
    expected: 'transient',
  },
  {
    name: 'claude-code credit balance is too low',
    provenance: 'captured',
    input: { message: 'Credit balance is too low', source: 'result-error' },
    expected: 'account:balance',
  },
  {
    name: 'claude-code invalid api key',
    provenance: 'captured',
    input: { message: 'Invalid API key · Please run /login', source: 'result-error' },
    expected: 'account:auth',
  },
  {
    name: 'antigravity quota on stderr',
    provenance: 'captured',
    input: { message: ANTIGRAVITY_QUOTA, source: 'stderr-tail' },
    expected: 'rate-limited',
  },
  {
    name: 'command-code weekly limit',
    provenance: 'captured',
    input: { message: COMMAND_CODE_RUN_ERROR, source: 'result-error' },
    expected: 'account:quota',
  },
  {
    name: 'command-code not authenticated',
    provenance: 'captured',
    input: { message: 'Not authenticated', source: 'result-error' },
    expected: 'account:auth',
  },
  {
    name: 'anthropic rate_limit_error',
    provenance: 'captured',
    input: { message: ANTHROPIC_RATE_LIMIT_BODY, source: 'result-error' },
    expected: 'transient',
  },
  {
    name: 'openai insufficient_quota',
    provenance: 'captured',
    input: { message: OPENAI_QUOTA, source: 'result-error' },
    expected: 'account:quota',
  },
  {
    name: 'gemini RESOURCE_EXHAUSTED',
    provenance: 'captured',
    input: { message: GEMINI_RESOURCE_EXHAUSTED, source: 'result-error' },
    expected: 'account:quota',
  },
  {
    name: 'deepseek 402 insufficient balance',
    provenance: 'synthetic',
    input: { message: 'Insufficient Balance', status: 402, source: 'thrown' },
    expected: 'account:balance',
  },
  {
    name: 'bare 429 with no corroboration',
    provenance: 'synthetic',
    input: { message: '429 slow down', source: 'result-error' },
    expected: 'other',
  },
  {
    name: 'thrown 429 with an unparseable body',
    provenance: 'synthetic',
    input: { message: 'slow down', status: 429, source: 'thrown' },
    expected: 'account:quota',
  },
];

describe('classifySeatFailure', () => {
  it.each(ENVELOPES)('$provenance $name -> $expected', ({ input, expected }) => {
    expect(label(classifySeatFailure(input))).toBe(expected);
  });

  it('reads a status 402 as an empty balance and 401/403 as a dead login', () => {
    expect(classifySeatFailure({ message: 'slow down', status: 402, source: 'thrown' })).toEqual({
      class: 'account',
      cause: 'balance',
    });
    expect(classifySeatFailure({ message: 'slow down', status: 401, source: 'thrown' })).toEqual({
      class: 'account',
      cause: 'auth',
    });
    expect(classifySeatFailure({ message: 'slow down', status: 403, source: 'thrown' })).toEqual({
      class: 'account',
      cause: 'auth',
    });
  });
});

describe('classifySeatFailure precedence', () => {
  it('an authoritative outcome outranks every phrase in the same text', () => {
    expect(
      classifySeatFailure({
        message: 'Insufficient Balance',
        outcome: 'checkout-changed',
        source: 'thrown',
      }),
    ).toEqual({ class: 'authoritative' });
  });

  it('an account phrase outranks a 429 in the same text', () => {
    expect(
      label(classifySeatFailure({ message: '429 Insufficient Balance', source: 'result-error' })),
    ).toBe('account:balance');
    expect(
      label(classifySeatFailure({ message: '429 insufficient_quota', source: 'result-error' })),
    ).toBe('account:quota');
  });

  it('a limit that names a reset is rate-limited, not transient', () => {
    const classification = classifySeatFailure({
      message: 'HTTP 429 (retry-after: 300)',
      source: 'result-error',
    });
    expect(classification.class).toBe('rate-limited');
    if (classification.class === 'rate-limited')
      expect(classification.resetAt).toBeInstanceOf(Date);
  });

  it('a bare 429 with no status and no corroboration is other', () => {
    expect(classifySeatFailure({ message: '429', source: 'result-error' })).toEqual({
      class: 'other',
    });
    expect(classifySeatFailure({ message: '429 slow down', source: 'result-error' })).toEqual({
      class: 'other',
    });
  });

  it('reads a network fault as transient and an unexplained outcome as other', () => {
    expect(classifySeatFailure({ message: 'connection reset by peer', source: 'thrown' })).toEqual({
      class: 'transient',
    });
    expect(classifySeatFailure({ message: 'HTTP 502 Bad Gateway', source: 'thrown' })).toEqual({
      class: 'transient',
    });
    expect(
      classifySeatFailure({
        message: 'DNS lookup failed',
        outcome: 'unauthenticated',
        source: 'thrown',
      }),
    ).toEqual({ class: 'other' });
  });
});

describe('classifySeatFailure tail sources', () => {
  it.each([
    ['payment required', 'other'],
    ['insufficient balance', 'other'],
    ['update your billing address', 'other'],
    ['rate limit exceeded', 'account:quota'],
    ['Not logged in', 'account:auth'],
  ])('reads %j on stderr as %s', (message, expected) => {
    expect(label(classifySeatFailure({ message, source: 'stderr-tail' }))).toBe(expected);
  });

  it('still waits out a tail limit that names a reset', () => {
    expect(
      label(
        classifySeatFailure({
          message: 'usage limit reached · resets in 2h6m30s',
          source: 'stderr-tail',
        }),
      ),
    ).toBe('rate-limited');
  });
});

describe('classifySeatFailure on the recorded DeepSeek balance refusal', () => {
  it('maps the opencode result to the usage-limit outcome on the first attempt', () => {
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'opencode-error', message: OPENCODE_DEEPSEEK_BALANCE },
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
    expect(outcome.remediation).not.toMatch(/log ?in|log ?out|authenticate/i);
  });
});

function opencodeFailure(line: string) {
  return opencodePlannerAdapter.terminal({
    outputContract: opencodePlannerAdapter.outputContract,
    events: opencodeProtocolEvents(line),
    stderr: '',
    exitCode: 1,
    signal: null,
  });
}

describe('classifySeatFailure on opencode error envelopes replayed through the adapter', () => {
  it('keeps provider.quota and the observed 429 from the Go-limit envelope', () => {
    const line = JSON.stringify({
      type: 'error',
      error: { type: 'provider.quota', message: 'Go usage limit exceeded', status: 429 },
    });
    const terminal = opencodeFailure(line);
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'completed') return;
    expect(terminal.error.providerType).toBe('provider.quota');
    expect(terminal.error.status).toBe(429);
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: terminal.error,
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
  });

  it('classifies the captured DeepSeek balance envelope as account:balance', () => {
    const line = JSON.stringify({
      type: 'error',
      error: {
        type: 'provider.quota',
        message: 'Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)',
      },
    });
    const terminal = opencodeFailure(line);
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'completed') return;
    expect(terminal.error.providerType).toBe('provider.quota');
    expect(terminal.error.status).toBeUndefined();
    const classification = classifySeatFailure({
      message: terminal.error.message,
      source: 'result-error',
    });
    expect(label(classification)).toBe('account:balance');
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: terminal.error,
        backendKind: 'cli',
      }),
    );
    expect(outcome.state).toBe('usage-limit');
    expect(outcome.remediation).not.toMatch(/log ?in|log ?out|authenticate/i);
  });
});

describe('classifySeatFailure on the recorded opencode no-route refusal', () => {
  it('halts the call as a missing model, never as a sign-out the words alone cannot prove', () => {
    const line = JSON.stringify({
      type: 'error',
      error: {
        type: 'provider.no-route',
        message: 'Model unavailable: ollama-cloud/deepseek-v4.1-flash',
      },
    });
    const terminal = opencodeFailure(line);
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'completed') return;
    expect(terminal.error.message).toBe(OPENCODE_NO_ROUTE);
    expect(classifyHaltSignature([terminal.error.message])).toBe('missing-model');
    expect(label(classifySeatFailure({ message: terminal.error.message, source: 'thrown' }))).toBe(
      'other',
    );
    expect(
      label(classifySeatFailure({ message: terminal.error.message, source: 'stderr-tail' })),
    ).toBe('other');
  });
});
