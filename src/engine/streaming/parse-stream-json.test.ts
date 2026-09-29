import { describe, expect, it } from 'vitest';
import { formatUsageLimitReset } from '../runners/usage-limit.js';
import { parseStreamLine } from './parse-stream-json.js';

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoTerminalResult(parsed: ReturnType<typeof parseStreamLine>): void {
  expect(parsed.text).toBeUndefined();
  expect(parsed.isResult).toBeUndefined();
  expect(parsed.isError).toBeUndefined();
}

describe('parseStreamLine', () => {
  it.each([
    [
      'assistant text and session',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'text', text: ' more text' },
          ],
        },
      }),
      {
        text: 'Hello world more text',
        channel: 'assistant',
        textSemantics: 'final',
        sessionId: 'sess-1',
      },
    ],
    [
      'result text, usage, and session',
      jsonLine({
        type: 'result',
        session_id: 'sess-2',
        result: 'Final answer here',
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
      {
        text: 'Final answer here',
        channel: 'result',
        sessionId: 'sess-2',
        isResult: true,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          counterCoverage: {
            input: 'reported',
            output: 'partial',
            cacheRead: 'missing',
            cacheCreate: 'missing',
            reasoning: 'missing',
          },
          providerTotals: { output: 500 },
        },
        usageSemantics: 'final',
      },
    ],
    [
      'result text without usage',
      jsonLine({
        type: 'result',
        session_id: 'sess-no-usage',
        result: 'Final answer only',
      }),
      {
        text: 'Final answer only',
        channel: 'result',
        sessionId: 'sess-no-usage',
        isResult: true,
      },
    ],
    [
      'session-only event',
      jsonLine({ type: 'system', session_id: 'sess-3' }),
      { sessionId: 'sess-3', isHeartbeat: true },
    ],
    [
      'assistant tool_use',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-tool',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'read_file',
              input: { path: '/tmp/test.ts' },
            },
          ],
        },
      }),
      {
        sessionId: 'sess-tool',
        textSemantics: 'final',
        toolUse: [{ id: 'tool-1', name: 'read_file', input: { path: '/tmp/test.ts' } }],
      },
    ],
    [
      'assistant mixed text and tool_use',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-mixed',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool_use',
              name: 'write_file',
              input: { path: '/tmp/out.ts', content: 'code' },
            },
          ],
        },
      }),
      {
        text: 'Let me read that file.',
        channel: 'assistant',
        textSemantics: 'final',
        sessionId: 'sess-mixed',
        toolUse: [{ name: 'write_file', input: { path: '/tmp/out.ts', content: 'code' } }],
      },
    ],
    [
      'assistant skips non-text non-tool blocks',
      jsonLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file' },
            { type: 'text', text: 'visible text' },
            { type: 'image', source: {} },
          ],
        },
      }),
      {
        text: 'visible text',
        channel: 'assistant',
        textSemantics: 'final',
        toolUse: [{ name: 'read_file', input: {} }],
      },
    ],
    [
      'malformed JSON',
      'not valid json {{{',
      {
        warning: [
          expect.objectContaining({
            code: 'malformed_stream_json',
            source: 'stream-json',
            parser: 'stream-json',
            upstreamType: 'malformed_json',
            channel: 'stdout',
            message: expect.stringContaining('Malformed stream-json record'),
            fingerprint: expect.stringMatching(/^rw:/),
          }),
        ],
      },
    ],
    ['empty line', '', {}],
    ['whitespace-only line', '   \t  ', {}],
    [
      'stream_event text delta',
      jsonLine({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'live' } },
      }),
      { text: 'live', channel: 'assistant', textSemantics: 'delta' },
    ],
    [
      'stream_event tool start',
      jsonLine({
        type: 'stream_event',
        session_id: 'sess-live',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-live', name: 'Read', input: {} },
        },
      }),
      { sessionId: 'sess-live', toolUseStart: [{ id: 'tool-live', name: 'Read', input: {} }] },
    ],
    [
      'stream_event tool input delta',
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/app.ts"}' },
        },
      }),
      {
        toolUseDelta: [{ id: 'content-block-1', inputDelta: '{"file_path":"src/app.ts"}' }],
      },
    ],
    [
      'a top-level retry frame',
      jsonLine({ type: 'api_retry', session_id: 'sess-retry' }),
      { sessionId: 'sess-retry', isHeartbeat: true },
    ],
    [
      'a top-level API error frame',
      jsonLine({ type: 'api_error', session_id: 'sess-error', message: 'Overloaded' }),
      {
        sessionId: 'sess-error',
        warning: [{ code: 'claude_api_error', severity: 'warning', message: 'Overloaded' }],
      },
    ],
  ] as const)('parses %s', (_name, line, expected) => {
    expect(parseStreamLine(line)).toEqual(expected);
  });

  it.each([
    ['init', { cwd: '/repo', model: 'opus' }, { isSessionInit: true }],
    ['hook_started', { hook_id: 'hook-1', hook_name: 'SessionStart:startup' }, {}],
    ['hook_response', { hook_id: 'hook-1', outcome: 'success', exit_code: 0 }, {}],
    ['status', { status: 'requesting' }, {}],
    ['thinking_tokens', { estimated_tokens: 120, estimated_tokens_delta: 40 }, {}],
    ['task_started', { task_id: 'task-1', description: 'Survey the readers' }, {}],
    ['task_notification', { task_id: 'task-1', status: 'completed', summary: 'done' }, {}],
    ['notification', { key: 'remote-tool-status-1', text: 'Uploading…', priority: 'medium' }, {}],
    ['informational', { content: 'Compacting conversation…', level: 'info' }, {}],
    ['informational', { content: 'Try /model to switch', level: 'suggestion' }, {}],
    ['informational', { content: 'PostToolUse:Edit says: formatted 2 files', level: 'notice' }, {}],
  ] as const)('reads system/%s as a heartbeat, never as text', (subtype, fields, flags) => {
    expect(
      parseStreamLine(jsonLine({ type: 'system', subtype, session_id: 'sess-frame', ...fields })),
    ).toEqual({ sessionId: 'sess-frame', isHeartbeat: true, ...flags });
  });

  // The frames Claude Code 2.1.282 builds when it changes the model, refuses, denies a tool or
  // shows a warning, with the fields its binary sets. A warning carries the severity its activity
  // row is coloured by: a plain notice warns, while a refusal with no fallback is an error.
  it.each([
    [
      'model_fallback',
      {
        trigger: 'overloaded',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-sonnet-5',
        content: 'Opus 5.5 is overloaded · using Sonnet 5 for this turn',
      },
      'claude_fallback',
      'claude-opus-5-5 → claude-sonnet-5 (overloaded)',
      'warning',
    ],
    [
      'model_refusal_fallback',
      {
        trigger: 'refusal',
        direction: 'retry',
        scope: 'session',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-opus-4-8',
        api_refusal_category: 'cyber',
        api_refusal_explanation: null,
        content: 'Switched to Opus 4.8 for this session',
      },
      'claude_fallback',
      'claude-opus-5-5 → claude-opus-4-8 (refusal: cyber)',
      'warning',
    ],
    [
      'model_consent_fallback',
      {
        choice: 'switch',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-sonnet-5',
        content: 'Switched to Sonnet 5 for this session',
      },
      'claude_fallback',
      'claude-opus-5-5 → claude-sonnet-5: Switched to Sonnet 5 for this session',
      'warning',
    ],
    [
      'model_refusal_no_fallback',
      {
        original_model: 'claude-opus-5',
        api_refusal_category: 'bio',
        api_refusal_explanation: null,
        content: '',
      },
      'claude_refusal',
      'claude-opus-5 refused (bio): no fallback model',
      'error',
    ],
    [
      'permission_denied',
      {
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        decision_reason_type: 'mode',
        message: 'Permission to use Bash has been denied.',
      },
      'claude_permission_denied',
      'Bash denied (mode): Permission to use Bash has been denied.',
      'warning',
    ],
    [
      'notification',
      {
        key: 'model-effort-cap',
        text: 'Effort max is not available on this model; using high',
        priority: 'high',
        color: 'warning',
      },
      'claude_notice',
      'Effort max is not available on this model; using high',
      'warning',
    ],
    [
      'informational',
      {
        content: `Model "claude-fable-5-1" is restricted by your organization's settings. Using claude-opus-5-5 instead.`,
        level: 'warning',
      },
      'claude_notice',
      `Model "claude-fable-5-1" is restricted by your organization's settings. Using claude-opus-5-5 instead.`,
      'warning',
    ],
  ])(
    'reads system/%s as a warning the operator can read',
    (subtype, fields, code, message, severity) => {
      expect(
        parseStreamLine(jsonLine({ type: 'system', subtype, session_id: 'sess-frame', ...fields })),
      ).toEqual({ sessionId: 'sess-frame', warning: [{ code, message, severity }] });
    },
  );

  // An error colour is the one notification colour that is not an ordinary warning.
  it('reads an error-coloured notification as an error', () => {
    expect(
      parseStreamLine(
        jsonLine({
          type: 'system',
          subtype: 'notification',
          session_id: 'sess-frame',
          key: 'usage-limit',
          text: "You've hit your usage limit · resets 3:45pm",
          priority: 'high',
          color: 'error',
        }),
      ),
    ).toEqual({
      sessionId: 'sess-frame',
      warning: [
        {
          code: 'claude_notice',
          severity: 'error',
          message: "You've hit your usage limit · resets 3:45pm",
        },
      ],
    });
  });

  // The shape Claude Code 2.1.282 prints before it retries a failed API request.
  it.each([
    [
      'no HTTP response',
      { attempt: 1, max_retries: 2, retry_delay_ms: 567, error_status: null, error: 'unknown' },
      'unknown (no HTTP response): retry 1 of 2 in 0.6s',
    ],
    [
      'an overloaded API',
      { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' },
      'overloaded (HTTP 529): retry 2 of 10 in 4.0s',
    ],
    ['fields it does not recognise', { attempt: 'second' }, 'retrying a failed API request'],
  ])('reads system/api_retry after %s as a warning', (_name, fields, message) => {
    expect(
      parseStreamLine(
        jsonLine({ type: 'system', subtype: 'api_retry', session_id: 'sess-retry', ...fields }),
      ),
    ).toEqual({
      sessionId: 'sess-retry',
      warning: [{ code: 'claude_api_retry', severity: 'warning', message }],
    });
  });

  it.each([
    ['leading space at a slice boundary', ' - b`'],
    ['a whitespace-only paragraph break', '\n\n'],
    ['a trailing space at a slice boundary', 'returning '],
  ])('keeps text deltas verbatim: %s', (_name, text) => {
    const line = jsonLine({
      type: 'stream_event',
      session_id: 'sess-verbatim',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });

    expect(parseStreamLine(line)).toEqual({
      text,
      channel: 'assistant',
      textSemantics: 'delta',
      sessionId: 'sess-verbatim',
    });
  });

  it('preserves result text and isResult when usage is malformed', () => {
    const line = jsonLine({
      type: 'result',
      session_id: 'sess-bad-usage',
      result: 'Final answer survives',
      usage: { input_tokens: '10', output_tokens: 5 },
    });

    expect(parseStreamLine(line)).toEqual({
      text: 'Final answer survives',
      channel: 'result',
      sessionId: 'sess-bad-usage',
      isResult: true,
    });
  });
});

// Claude Code's SDKRateLimitEvent: `allowed` is the steady state and only an approaching or
// rejected limit is news for the operator. `overageStatus` can stay `rejected` while `status`
// is `allowed` and must not escalate the frame on its own.
describe('rate_limit_event frames', () => {
  const resetsAt = 1_794_000_000;
  const resetLabel = formatUsageLimitReset(new Date(resetsAt * 1000));
  const rateFrame = (rateLimitInfo: unknown): string =>
    jsonLine({
      type: 'rate_limit_event',
      session_id: 'sess-rate',
      rate_limit_info: rateLimitInfo,
    });

  it.each([
    ['allowed', { status: 'allowed', rateLimitType: 'seven_day', resetsAt }],
    [
      'allowed beside a rejected overage',
      { status: 'allowed', rateLimitType: 'seven_day', resetsAt, overageStatus: 'rejected' },
    ],
  ])('reads a %s rate frame as telemetry, not a failure', (_name, rateLimitInfo) => {
    expect(parseStreamLine(rateFrame(rateLimitInfo))).toEqual({
      sessionId: 'sess-rate',
      isHeartbeat: true,
    });
  });

  it('warns when the status approaches a limit, without inventing a result', () => {
    const parsed = parseStreamLine(
      rateFrame({ status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt }),
    );

    expect(parsed.sessionId).toBe('sess-rate');
    expectNoTerminalResult(parsed);
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        message: `seven_day rate limit approaching (resets ${resetLabel})`,
      },
    ]);
  });

  it('signals error severity when the status rejects the turn', () => {
    const parsed = parseStreamLine(
      rateFrame({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    );

    expect(parsed.sessionId).toBe('sess-rate');
    expectNoTerminalResult(parsed);
    expect(parsed.warning).toEqual([
      {
        code: 'claude_rate_limit',
        severity: 'error',
        message: `five_hour rate limit reached (resets ${resetLabel})`,
      },
    ]);
    expect(parsed.warning?.[0]?.message.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ['with no status', { rateLimitType: 'seven_day' }],
    ['with an unknown status', { status: 'exceeded', rateLimitType: 'seven_day' }],
    ['whose info is not an object', 'rejected'],
  ])('reads a rate frame %s as telemetry, not a limit', (_name, rateLimitInfo) => {
    const parsed = parseStreamLine(rateFrame(rateLimitInfo));

    expect(parsed.sessionId).toBe('sess-rate');
    expect(parsed.warning).toBeUndefined();
    expectNoTerminalResult(parsed);
  });
});

it('identifies actual native init independently from result session IDs', () => {
  expect(
    parseStreamLine(jsonLine({ type: 'system', subtype: 'init', session_id: 'sess-1' })),
  ).toMatchObject({ isSessionInit: true, sessionId: 'sess-1' });
  expect(
    parseStreamLine(
      jsonLine({
        type: 'result',
        session_id: 'sess-1',
        is_error: true,
        result: 'session not found',
      }),
    ).isSessionInit,
  ).toBeUndefined();
});
