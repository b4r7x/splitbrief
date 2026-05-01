import { describe, expect, test } from 'vitest';
import { matches } from '../../utils/error.js';
import { streamError, throwMappedError } from './stream-errors.js';

describe('streamError factories', () => {
  test('connectionRefused records provider + apiBase + redacts secrets in message', () => {
    const err = streamError.connectionRefused('ollama', 'http://localhost:11434');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('stream-connection-refused');
    expect(err.message).toContain('ollama');
    expect(err.data).toEqual({ provider: 'ollama', apiBase: 'http://localhost:11434' });
  });

  test('connectionRefused threads cause', () => {
    const cause = Object.assign(new Error('ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    const err = streamError.connectionRefused('ollama', 'http://localhost:11434', cause);
    expect(err.cause).toBe(cause);
  });

  test('connectionRefused handles undefined apiBase', () => {
    const err = streamError.connectionRefused('ollama', undefined);
    expect(err.kind).toBe('stream-connection-refused');
    expect(err.data).toEqual({ provider: 'ollama', apiBase: undefined });
  });

  test('httpStatus records status + detail', () => {
    const err = streamError.httpStatus('openai', 429, 'rate limited');
    expect(err.kind).toBe('stream-http-status');
    expect(err.data).toEqual({ provider: 'openai', status: 429, detail: 'rate limited' });
  });

  test('httpStatus threads cause', () => {
    const cause = new Error('raw http error');
    const err = streamError.httpStatus('openai', 500, 'boom', cause);
    expect(err.cause).toBe(cause);
  });

  test('httpStatus redacts secrets in message', () => {
    const err = streamError.httpStatus('openai', 500, 'leaked sk-ant-1234567890abcdefghijklmnopqrstuvwxyz boom');
    expect(err.message).not.toContain('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz');
    expect(err.message).toContain('***REDACTED***');
  });

  test('apiError records detail', () => {
    const err = streamError.apiError('anthropic', 'overloaded');
    expect(err.kind).toBe('stream-api-error');
    expect(err.data).toEqual({ provider: 'anthropic', detail: 'overloaded' });
  });

  test('apiError threads cause', () => {
    const cause = new Error('raw');
    const err = streamError.apiError('anthropic', 'x', cause);
    expect(err.cause).toBe(cause);
  });

  test('emptyResponse records provider', () => {
    const err = streamError.emptyResponse('Anthropic');
    expect(err.kind).toBe('stream-empty-response');
    expect(err.message).toContain('Anthropic');
    expect(err.data).toEqual({ provider: 'Anthropic' });
  });

  test('invalidPayload records reason and optional cause', () => {
    const cause = new SyntaxError('unexpected token');
    const err = streamError.invalidPayload('bad json', cause);
    expect(err.kind).toBe('stream-invalid-payload');
    expect(err.data).toEqual({ reason: 'bad json' });
    expect(err.cause).toBe(cause);
  });
});

describe('throwMappedError', () => {
  test('wraps ECONNREFUSED into connectionRefused with original as cause', () => {
    const underlying = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    try {
      throwMappedError(underlying, { provider: 'ollama', apiBase: 'http://localhost:11434' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-connection-refused')(err)).toBe(true);
      expect((err as Error & { cause?: unknown }).cause).toBe(underlying);
    }
  });

  test('wraps nested ECONNREFUSED cause', () => {
    const inner = Object.assign(new Error('low'), { code: 'ECONNREFUSED' });
    const outer = Object.assign(new Error('fetch failed'), { cause: inner });
    try {
      throwMappedError(outer, { provider: 'ollama', apiBase: 'http://localhost:11434' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-connection-refused')(err)).toBe(true);
      expect((err as Error & { cause?: unknown }).cause).toBe(outer);
    }
  });

  test('wraps HTTP status errors with original as cause', () => {
    const underlying = Object.assign(new Error('Too Many Requests'), { status: 429 });
    try {
      throwMappedError(underlying, { provider: 'openai' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-http-status')(err)).toBe(true);
      if (matches('stream-http-status')(err)) {
        expect(err.data).toMatchObject({ status: 429, provider: 'openai' });
      }
      expect((err as Error & { cause?: unknown }).cause).toBe(underlying);
    }
  });

  test('rethrows unknown (non-error-like) values as-is', () => {
    expect(() => throwMappedError('string value')).toThrow('string value');
  });

  test('rethrows errors without known code/status unchanged', () => {
    const plain = new Error('mystery');
    expect(() => throwMappedError(plain)).toThrow(plain);
  });
});
