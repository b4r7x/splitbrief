import { describe, it, expect, vi } from 'vitest';
import { fetchJsonWithTimeout, fetchModelList } from './request.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('fetchJsonWithTimeout', () => {
  setupFetchMock();

  it('returns parsed JSON on 2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    );
    const result = await fetchJsonWithTimeout('https://api.example.com/v1', 1000);
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws on non-ok status with HTTP code in message', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('err', { status: 503 }));
    await expect(fetchJsonWithTimeout('https://api.example.com/v1', 1000)).rejects.toThrow(
      'HTTP 503',
    );
  });

  it('aborts with a AbortError when the timeout fires before response', async () => {
    let signalRef: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
      signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signalRef?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    await expect(fetchJsonWithTimeout('https://slow.example.com', 5)).rejects.toThrow(
      /abort|timeout/i,
    );
    expect(signalRef?.aborted).toBe(true);
  });
});

describe('fetchModelList', () => {
  setupFetchMock();

  const defaultExtract = (data: unknown): Array<{ id: string }> | null => {
    if (typeof data !== 'object' || data === null) return null;
    const list = (data as { data?: unknown }).data;
    if (!Array.isArray(list)) return null;
    return list.map((entry) => ({ id: (entry as { id: string }).id }));
  };

  it('returns extracted models on 200 + valid payload and clears error on onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'k',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }]);
    expect(errors.at(-1)).toBeUndefined();
  });

  it('passes an AbortSignal to fetch and aborts when the request stalls past the timeout', async () => {
    vi.useFakeTimers();
    try {
      let signalRef: AbortSignal | undefined;
      vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
        signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signalRef?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });

      const errors: Array<string | undefined> = [];
      const pending = fetchModelList({
        endpoint: 'https://slow.example.com/v1/models',
        onError: (err: string | undefined) => errors.push(err),
        extractModels: defaultExtract,
      });

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(signalRef).toBeInstanceOf(AbortSignal);
      expect(signalRef?.aborted).toBe(true);
      expect(result).toEqual([]);
      expect(errors.some((e) => /abort|timeout/i.test(e ?? ''))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses custom headers verbatim when provided (no Authorization injection)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'should-be-ignored',
      headers: { 'x-api-key': 'custom' },
      extractModels: defaultExtract,
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'x-api-key': 'custom' } }),
    );
  });

  it('returns [] on non-ok and reports HTTP status via onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('bad', { status: 401 }));
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('HTTP 401');
  });

  it('returns [] when fetch throws (network error) and reports error message', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network failure'));
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors.some((e) => e?.includes('network failure'))).toBe(true);
  });

  it('returns [] when body is not a JSON object and reports "Invalid response payload"', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify('a string, not an object'), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('Invalid response payload');
  });

  it('returns [] when extractor returns null (unrecognized shape)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ not: 'valid' }), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('Invalid response payload');
  });
});
