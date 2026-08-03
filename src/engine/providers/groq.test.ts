import { describe, expect, it, vi } from 'vitest';
import { createGroqProvider } from './groq.js';
import { setupEnvMock, setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('createGroqProvider', () => {
  setupFetchMock();
  setupEnvMock('GROQ_API_KEY', 'gsk_test-key');

  it('keeps text-generation and unknown private IDs while excluding documented non-text rows', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'llama-3.3-70b-versatile',
              display_name: 'Llama 3.3 70B Versatile',
              context_window: 131_072,
            },
            { id: 'whisper-large-v3-turbo' },
            { id: 'llama-guard-3-8b' },
            { id: 'playai-tts' },
            { id: 'project-private-model-2026' },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await createGroqProvider().listModelsWithMetadata()).toEqual([
      {
        id: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B Versatile',
        contextLength: 131_072,
      },
      { id: 'project-private-model-2026' },
    ]);
  });

  it('filters a known non-text type without treating an unknown type as non-generative', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'known-moderation', type: 'moderation' },
            { id: 'customer-special-model', type: 'private-product-category' },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await createGroqProvider().listModels()).toEqual(['customer-special-model']);
  });

  it('retains an HTTP 403 diagnostic for upstream policy classification', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('denied', { status: 403 }));

    const provider = createGroqProvider();
    expect(await provider.listModels()).toEqual([]);
    expect(provider.getLastError?.()).toBe('HTTP 403');
  });
});
