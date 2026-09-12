import { describe, expect, it } from 'vitest';
import {
  CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER,
  CALL_CONSUMER_REDACTION_MARKER,
  CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER,
  CALL_HOOKS_MAX_PUBLIC_PAYLOAD_BYTES,
  CALL_HOOKS_MAX_PUBLIC_STRING_BYTES,
  CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES,
  CALL_SESSION_LOG_MAX_PUBLIC_STRING_BYTES,
  CALL_STDOUT_JSON_MAX_PUBLIC_PAYLOAD_BYTES,
  CALL_STDOUT_JSON_MAX_PUBLIC_STRING_BYTES,
  CALL_TUI_MAX_PUBLIC_PAYLOAD_BYTES,
  CALL_TUI_MAX_PUBLIC_STRING_BYTES,
  boundConsumerPayload,
  getConsumerPayloadPolicy,
  redactPublicPayload,
  type PublicPayload,
} from './payload-bounds.js';

describe('consumer payload bounds', () => {
  it('publishes context-specific byte defaults', () => {
    expect(getConsumerPayloadPolicy('tui')).toEqual({
      context: 'tui',
      maxBytes: CALL_TUI_MAX_PUBLIC_PAYLOAD_BYTES,
      maxStringBytes: CALL_TUI_MAX_PUBLIC_STRING_BYTES,
    });
    expect(getConsumerPayloadPolicy('stdout-json')).toEqual({
      context: 'stdout-json',
      maxBytes: CALL_STDOUT_JSON_MAX_PUBLIC_PAYLOAD_BYTES,
      maxStringBytes: CALL_STDOUT_JSON_MAX_PUBLIC_STRING_BYTES,
    });
    expect(getConsumerPayloadPolicy('stdout-text')).toEqual({
      context: 'stdout-text',
      maxBytes: CALL_STDOUT_JSON_MAX_PUBLIC_PAYLOAD_BYTES,
      maxStringBytes: CALL_STDOUT_JSON_MAX_PUBLIC_STRING_BYTES,
    });
    expect(getConsumerPayloadPolicy('hooks')).toEqual({
      context: 'hooks',
      maxBytes: CALL_HOOKS_MAX_PUBLIC_PAYLOAD_BYTES,
      maxStringBytes: CALL_HOOKS_MAX_PUBLIC_STRING_BYTES,
    });
    expect(getConsumerPayloadPolicy('session-log')).toEqual({
      context: 'session-log',
      maxBytes: CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES,
      maxStringBytes: CALL_SESSION_LOG_MAX_PUBLIC_STRING_BYTES,
    });
  });

  it('redacts obvious secrets and API keys throughout public payloads', () => {
    const anthropicKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    const githubToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const result = boundConsumerPayload({
      context: 'stdout-json',
      payload: {
        headers: { authorization: `Bearer ${anthropicKey}` },
        apiKey: githubToken,
        nested: ['safe', `password="${anthropicKey}"`],
      },
    });

    const serialized = JSON.stringify(result.payload);
    expect(result.redacted).toBe(true);
    expect(serialized).not.toContain(anthropicKey);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).toContain(CALL_CONSUMER_REDACTION_MARKER);
  });

  it('redacts without requiring a consumer context', () => {
    const result = redactPublicPayload({
      payload: { token: 'xai-abcdefghijklmnopqrstuvwxyz123456' },
    });

    expect(result).toEqual({
      payload: { token: `xai-${CALL_CONSUMER_REDACTION_MARKER}` },
      redacted: true,
    });
  });

  it('bounds oversized strings with a stable truncation placeholder', () => {
    const result = boundConsumerPayload({
      context: 'hooks',
      overrides: { maxBytes: 512, maxStringBytes: 80 },
      payload: { message: `prefix ${'x'.repeat(200)}` },
    });
    const payload = expectRecord(result.payload);
    const message = expectString(payload.message);

    expect(result.truncated).toBe(true);
    expect(result.oversized).toBe(false);
    expect(message.endsWith(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER)).toBe(true);
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(80);
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.payload), 'utf8'));
    expect(result.bytes).toBeLessThanOrEqual(result.maxBytes);
  });

  it('omits whole payloads that remain oversized after value bounding', () => {
    const payload = { chunks: Array.from({ length: 30 }, (_, index) => `chunk-${index}`) };
    const first = boundConsumerPayload({
      context: 'session-log',
      overrides: { maxBytes: 64, maxStringBytes: 64 },
      payload,
    });
    const second = boundConsumerPayload({
      context: 'session-log',
      overrides: { maxBytes: 64, maxStringBytes: 64 },
      payload,
    });

    expect(first.payload).toBe(CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER);
    expect(second.payload).toBe(CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER);
    expect(first.payload).toBe(second.payload);
    expect(first.oversized).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.bytes).toBeLessThanOrEqual(first.maxBytes);
  });

  it('omits payloads whose UTF-8 JSON byte size exceeds maxBytes even when code units fit', () => {
    const emoji = '🙂';
    const payload = { note: emoji.repeat(40) };
    const jsonBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    expect(payload.note.length).toBeLessThan(jsonBytes);

    const result = boundConsumerPayload({
      context: 'session-log',
      overrides: { maxBytes: jsonBytes - 1, maxStringBytes: 10_000 },
      payload,
    });

    expect(result.payload).toBe(CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER);
    expect(result.oversized).toBe(true);
  });

  it('redacts before truncating so secrets cannot survive at the kept prefix', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    const result = boundConsumerPayload({
      context: 'hooks',
      overrides: { maxBytes: 512, maxStringBytes: 96 },
      payload: { text: `${secret} ${'x'.repeat(200)}` },
    });
    const payload = expectRecord(result.payload);
    const text = expectString(payload.text);

    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(text).not.toContain(secret);
    expect(text).toContain(`sk-ant-${CALL_CONSUMER_REDACTION_MARKER}`);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(96);
  });

  it('canonicalizes terminal controls before redacting public payload strings', () => {
    const result = boundConsumerPayload({
      context: 'tui',
      payload: { text: 'key=sk-\u001b[31mabcdefghijklmnopqrstuvwxyz' },
    });
    const payload = expectRecord(result.payload);

    expect(result.redacted).toBe(true);
    expect(payload.text).toBe(`key=sk-${CALL_CONSUMER_REDACTION_MARKER}`);
  });
});

function expectRecord(value: PublicPayload): { [key: string]: PublicPayload } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected record payload, got ${typeof value}`);
  }
  return value;
}

function expectString(value: PublicPayload | undefined): string {
  if (typeof value !== 'string') {
    throw new Error(`expected string payload, got ${typeof value}`);
  }
  return value;
}
