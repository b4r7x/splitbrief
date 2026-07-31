import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from './ollama.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

// Shared list-contract lives in provider-contract.test.ts. This file covers Ollama-specific
// detectContextLength which POSTs to /api/show and parses `num_ctx` from the parameters string.
describe('createOllamaProvider detectContextLength (via /api/show)', () => {
  setupFetchMock();

  it('parses num_ctx from parameters', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ parameters: 'num_ctx 32768\ntemperature 0.7' }), {
        status: 200,
      }),
    );

    const result = await createOllamaProvider().detectContextLength('qwen:7b');
    expect(result).toBe(32768);
  });

  it('returns null when num_ctx is absent', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ parameters: 'temperature 0.7' }), { status: 200 }),
    );

    const result = await createOllamaProvider().detectContextLength('qwen:7b');
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));
    const result = await createOllamaProvider().detectContextLength('qwen:7b');
    expect(result).toBeNull();
  });

  it('follows same-origin redirects for the context probe', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: '/api/show/redirected' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ parameters: 'num_ctx 16384' }), { status: 200 }),
      );

    const result = await createOllamaProvider().detectContextLength('qwen:7b');

    expect(result).toBe(16384);
    const redirectedRequest = vi.mocked(globalThis.fetch).mock.calls[1]?.[0];
    expect(redirectedRequest).toBeInstanceOf(Request);
    if (!(redirectedRequest instanceof Request)) throw new Error('expected redirected Request');
    expect(redirectedRequest.url).toBe('http://localhost:11434/api/show/redirected');
  });

  it('does not follow a context-probe redirect outside loopback origin', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'http://evil.example.net/collect' },
      }),
    );

    const result = await createOllamaProvider().detectContextLength('qwen:7b');

    expect(result).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an Ollama endpoint outside loopback before construction', () => {
    expect(() => createOllamaProvider({ apiBase: 'http://192.168.0.2:11434/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
