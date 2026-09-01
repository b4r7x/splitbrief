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

  test('connectionRefused handles undefined apiBase', () => {
    const err = streamError.connectionRefused('ollama', undefined);
    expect(err.kind).toBe('stream-connection-refused');
    expect(err.data).toEqual({ provider: 'ollama', apiBase: undefined });
  });

  test('httpStatus records status + detail', () => {
    const err = streamError.httpStatus('custom-endpoint', 429, 'rate limited');
    expect(err.kind).toBe('stream-http-status');
    expect(err.data).toEqual({ provider: 'custom-endpoint', status: 429, detail: 'rate limited' });
  });

  test('httpStatus redacts secrets in message', () => {
    const err = streamError.httpStatus(
      'custom-endpoint',
      500,
      'leaked sk-ant-1234567890abcdefghijklmnopqrstuvwxyz boom',
    );
    expect(err.message).not.toContain('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz');
    expect(err.message).toContain('***REDACTED***');
    expect(err.data.detail).not.toContain('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz');
  });

  test('apiError records detail', () => {
    const err = streamError.apiError('custom-endpoint', 'overloaded');
    expect(err.kind).toBe('stream-api-error');
    expect(err.data).toEqual({ provider: 'custom-endpoint', detail: 'overloaded' });
  });

  test('apiError redacts secrets in data', () => {
    const err = streamError.apiError('custom-endpoint', 'token=github_pat_1234567890abcdef');
    expect(err.message).not.toContain('github_pat_1234567890abcdef');
    expect(err.data.detail).toBe('token=github_pat_***REDACTED***');
  });

  test('apiError threads cause', () => {
    const cause = new Error('raw');
    const err = streamError.apiError('custom-endpoint', 'x', cause);
    expect(err.cause).toBe(cause);
  });

  test('emptyResponse records provider', () => {
    const err = streamError.emptyResponse('custom-endpoint');
    expect(err.kind).toBe('stream-empty-response');
    expect(err.message).toContain('custom-endpoint');
    expect(err.data).toEqual({ provider: 'custom-endpoint' });
  });

  test('invalidPayload records reason and optional cause', () => {
    const cause = new SyntaxError('unexpected token');
    const err = streamError.invalidPayload('bad json', cause);
    expect(err.kind).toBe('stream-invalid-payload');
    expect(err.data).toEqual({ reason: 'bad json' });
    expect(err.cause).toBe(cause);
  });

  test('invalidPayload redacts secrets in data', () => {
    const err = streamError.invalidPayload('bad payload with password=hunter2hunter2hunter2');
    expect(err.message).not.toContain('hunter2hunter2hunter2');
    expect(err.data.reason).toBe('bad payload with password=***REDACTED***');
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

  test('wraps a refused connection nested two cause levels deep', () => {
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
    });
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: econnrefused });
    const apiConnectionError = Object.assign(new Error('Connection error.'), {
      cause: fetchFailed,
    });
    try {
      throwMappedError(apiConnectionError, {
        provider: 'ollama',
        apiBase: 'http://localhost:11434',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-connection-refused')(err)).toBe(true);
      expect((err as Error & { message: string }).message).toContain('Ollama is not running');
    }
  });

  test('recognizes an OpenAI APIConnectionError by name as a connection failure', () => {
    const apiConnectionError = Object.assign(new Error('Connection error.'), {
      name: 'APIConnectionError',
    });
    try {
      throwMappedError(apiConnectionError, {
        provider: 'ollama',
        apiBase: 'http://localhost:11434',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-connection-refused')(err)).toBe(true);
      expect((err as Error & { message: string }).message).toContain('Ollama is not running');
    }
  });

  test('wraps HTTP status errors with original as cause', () => {
    const underlying = Object.assign(new Error('Too Many Requests'), { status: 429 });
    try {
      throwMappedError(underlying, { provider: 'custom-endpoint' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-http-status')(err)).toBe(true);
      if (matches('stream-http-status')(err)) {
        expect(err.data).toMatchObject({ status: 429, provider: 'custom-endpoint' });
      }
      expect((err as Error & { cause?: unknown }).cause).toBe(underlying);
    }
  });

  test('appends a 429 Retry-After header to the detail so the reset survives mapping', () => {
    const underlying = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
    });
    try {
      throwMappedError(underlying, { provider: 'custom-endpoint' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-http-status')(err)).toBe(true);
      if (matches('stream-http-status')(err)) {
        expect(err.data).toMatchObject({ detail: expect.stringContaining('(retry-after: 60s)') });
      }
    }
  });

  test('ignores Retry-After on non-429 statuses and non-numeric values', () => {
    const serverError = Object.assign(new Error('Internal'), {
      status: 500,
      headers: new Headers({ 'retry-after': '60' }),
    });
    let serverThrown: unknown;
    try {
      throwMappedError(serverError, { provider: 'custom-endpoint' });
    } catch (err) {
      serverThrown = err;
    }
    expect(matches('stream-http-status')(serverThrown)).toBe(true);
    if (matches('stream-http-status')(serverThrown)) {
      expect(serverThrown.data).not.toMatchObject({
        detail: expect.stringContaining('retry-after'),
      });
    }

    const dateHeader = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: new Headers({ 'retry-after': 'Fri, 07 Aug 2026 17:00:00 GMT' }),
    });
    let dateThrown: unknown;
    try {
      throwMappedError(dateHeader, { provider: 'custom-endpoint' });
    } catch (err) {
      dateThrown = err;
    }
    expect(matches('stream-http-status')(dateThrown)).toBe(true);
    if (matches('stream-http-status')(dateThrown)) {
      expect(dateThrown.data).not.toMatchObject({
        detail: expect.stringContaining('retry-after'),
      });
    }
  });

  test('terminates on a self-referential cause chain instead of hanging', () => {
    const cyclic = Object.assign(new Error('cyclic'), {}) as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(() => throwMappedError(cyclic, { provider: 'ollama' })).toThrow(cyclic);
  });

  test('terminates on a multi-node cause cycle and still detects ECONNREFUSED', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    }) as Error & { cause?: unknown };
    const outer = Object.assign(new Error('fetch failed'), { cause: refused }) as Error & {
      cause?: unknown;
    };
    refused.cause = outer;
    try {
      throwMappedError(outer, { provider: 'ollama', apiBase: 'http://localhost:11434' });
      throw new Error('expected throw');
    } catch (err) {
      expect(matches('stream-connection-refused')(err)).toBe(true);
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
