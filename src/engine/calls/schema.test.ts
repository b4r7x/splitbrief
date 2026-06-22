import { describe, expect, it } from 'vitest';
import { RUNNER_KINDS } from '../../core/schemas/enums.js';
import {
  RUNNER_CALL_BACKEND_KINDS,
  RUNNER_CALL_TEXT_CHANNELS,
} from '../../core/runner-call-contract.js';
import {
  RunnerCallEventSchema,
  RunnerCallResultSchema,
  RunnerCallUsageSchema,
  UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH,
} from './schema.js';

const context = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
} as const;

const usage = {
  inputTokens: 1,
  outputTokens: 2,
} as const;

const terminalFields = {
  startedAt: 1,
  endedAt: 11,
  durationMs: 10,
  partial: false,
  usage,
  nativeSessionId: null,
} as const;

describe('RunnerCallEventSchema', () => {
  it('derives runner-call backend kinds from the canonical runner kind tuple', () => {
    expect(RUNNER_CALL_BACKEND_KINDS).toBe(RUNNER_KINDS);
  });

  it('validates call text deltas from the canonical text channel tuple', () => {
    expect(
      RUNNER_CALL_TEXT_CHANNELS.map(
        (channel) =>
          RunnerCallEventSchema.safeParse({
            type: 'call_text_delta',
            ts: 1,
            ...context,
            channel,
            text: `${channel} text`,
          }).success,
      ),
    ).toEqual(RUNNER_CALL_TEXT_CHANNELS.map(() => true));
    expect(
      RunnerCallEventSchema.safeParse({
        type: 'call_text_delta',
        ts: 1,
        ...context,
        channel: 'stderr',
        text: 'diagnostic text',
      }).success,
    ).toBe(false);
  });

  it('accepts the runner call event variants emitted by the call subsystem', () => {
    const events = [
      { type: 'call_started', ts: 1, ...context },
      {
        type: 'call_text_delta',
        ts: 1,
        ...context,
        channel: 'assistant',
        text: 'hello',
      },
      {
        type: 'call_stderr_delta',
        ts: 1,
        ...context,
        channel: 'stderr',
        text: 'warning',
      },
      {
        type: 'call_tool_use_delta',
        ts: 1,
        ...context,
        channel: 'tool',
        toolUseId: 'tool-1',
        name: 'read_file',
        inputDelta: '{"path"',
      },
      {
        type: 'call_tool_use_done',
        ts: 1,
        ...context,
        channel: 'tool',
        toolUse: { id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
      },
      {
        type: 'call_usage',
        ts: 1,
        ...context,
        usage,
        semantics: 'delta',
      },
      {
        type: 'call_session_id',
        ts: 1,
        ...context,
        nativeSessionId: 'session-1',
      },
      {
        type: 'call_artifact',
        ts: 1,
        ...context,
        artifact: {
          id: 'artifact-1',
          source: 'file',
          name: 'plan.md',
          path: '.diptych/sessions/one/plan.md',
          mimeType: 'text/markdown',
          text: null,
        },
      },
      {
        type: 'call_warning',
        ts: 1,
        ...context,
        warning: {
          code: 'slow_stream',
          message: 'stream slowed',
          parser: 'jsonl',
          upstreamType: 'mystery',
          channel: 'stdout',
        },
      },
      {
        type: 'call_error',
        ts: 1,
        ...context,
        status: 'timeout',
        error: { code: 'timeout', message: 'runner timed out' },
        ...terminalFields,
        partial: true,
      },
      {
        type: 'call_completed',
        ts: 1,
        ...context,
        status: 'completed',
        error: null,
        ...terminalFields,
      },
      {
        type: 'call_unknown_upstream',
        ts: 1,
        ...context,
        rawPreview: '{"type":"new_event"}',
        backendMetadata: {
          backendKind: 'cli',
          channel: 'stdout',
          source: 'codex',
          parser: 'jsonl',
          upstreamType: 'new_event',
        },
      },
    ];

    expect(events.map((event) => RunnerCallEventSchema.safeParse(event).success)).toEqual(
      events.map(() => true),
    );
  });

  it('normalizes warning metadata and stable fingerprints', () => {
    const first = RunnerCallEventSchema.parse({
      type: 'call_warning',
      ts: 1,
      ...context,
      warning: {
        code: 'provider_retry',
        source: 'provider',
        message: 'retrying session sess_123 attempt 1 after 23ms at 2026-06-21T10:00:00.000Z',
      },
    });
    const repeated = RunnerCallEventSchema.parse({
      type: 'call_warning',
      ts: 2,
      ...context,
      warning: {
        code: 'provider_retry',
        source: 'provider',
        message: 'retrying session sess_999 attempt 4 after 991ms at 2026-06-21T10:01:00.000Z',
      },
    });

    if (first.type !== 'call_warning' || repeated.type !== 'call_warning') {
      throw new Error('expected call_warning events');
    }
    expect(first.warning).toMatchObject({
      code: 'provider_retry',
      severity: 'warning',
      source: 'provider',
      surface: 'activity',
      fingerprint: expect.stringMatching(/^rw:/),
    });
    expect(first.warning.fingerprint).toBe(repeated.warning.fingerprint);
  });

  it('rejects unknown fields on known event variants', () => {
    expect(
      RunnerCallEventSchema.safeParse({
        type: 'call_text_delta',
        ts: 1,
        ...context,
        channel: 'assistant',
        text: 'hello',
        upstreamPayload: { type: 'assistant' },
      }).success,
    ).toBe(false);
  });

  it('keeps unknown upstream data behind a bounded raw preview and backend metadata', () => {
    const event = {
      type: 'call_unknown_upstream',
      ts: 1,
      ...context,
      rawPreview: '{"type":"future"}',
      backendMetadata: {
        backendKind: 'cli',
        channel: 'stdout',
        source: 'codex',
      },
    } as const;

    expect(RunnerCallEventSchema.safeParse(event).success).toBe(true);
    expect(
      RunnerCallEventSchema.safeParse({
        ...event,
        rawPreview: 'x'.repeat(UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      RunnerCallEventSchema.safeParse({
        ...event,
        raw: { type: 'future' },
      }).success,
    ).toBe(false);
  });

  it('only treats completed as a successful terminal completion event', () => {
    expect(
      RunnerCallEventSchema.safeParse({
        type: 'call_completed',
        ts: 1,
        ...context,
        status: 'completed',
        error: null,
        ...terminalFields,
      }).success,
    ).toBe(true);
    expect(
      RunnerCallEventSchema.safeParse({
        type: 'call_completed',
        ts: 1,
        ...context,
        status: 'failed',
        error: null,
        ...terminalFields,
      }).success,
    ).toBe(false);
    expect(
      RunnerCallEventSchema.safeParse({
        type: 'call_error',
        ts: 1,
        ...context,
        status: 'completed',
        error: { code: 'bad', message: 'bad' },
        ...terminalFields,
      }).success,
    ).toBe(false);
  });
});

describe('RunnerCallUsageSchema', () => {
  it('rejects negative and fractional token counts', () => {
    expect(
      RunnerCallUsageSchema.safeParse({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        reasoningTokens: 0,
      }).success,
    ).toBe(true);
    expect(RunnerCallUsageSchema.safeParse({ inputTokens: -1, outputTokens: 0 }).success).toBe(
      false,
    );
    expect(RunnerCallUsageSchema.safeParse({ inputTokens: 1.5, outputTokens: 0 }).success).toBe(
      false,
    );
  });
});

describe('RunnerCallResultSchema', () => {
  it('keeps the aggregate result contract strict', () => {
    const result = {
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'agent',
      status: 'completed',
      startedAt: 1,
      endedAt: 11,
      durationMs: 10,
      text: 'done',
      usage: null,
      nativeSessionId: null,
      toolUses: [],
      artifacts: [],
      warnings: [],
      error: null,
      partial: false,
    } as const;

    expect(RunnerCallResultSchema.safeParse(result).success).toBe(true);
    expect(RunnerCallResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(
      RunnerCallResultSchema.safeParse({
        ...result,
        usage: { inputTokens: 1, outputTokens: -1 },
      }).success,
    ).toBe(false);
    expect(
      RunnerCallResultSchema.safeParse({
        ...result,
        partial: true,
      }).success,
    ).toBe(false);
    expect(
      RunnerCallResultSchema.safeParse({
        ...result,
        status: 'timeout',
        error: null,
        partial: true,
      }).success,
    ).toBe(false);
    expect(
      RunnerCallResultSchema.safeParse({
        ...result,
        status: 'timeout',
        error: { code: 'timeout', message: 'runner timed out' },
        partial: true,
      }).success,
    ).toBe(true);
  });
});
