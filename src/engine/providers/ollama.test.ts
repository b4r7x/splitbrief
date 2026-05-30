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
});
