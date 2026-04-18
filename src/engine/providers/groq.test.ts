import { describe, it, expect, vi } from 'vitest';
import { createGroqProvider } from './groq.js';
import { setupFetchMock, setupEnvMock } from './__test-helpers__.js';

// Shared contract (listModels / detectContextLength / error paths / overrides) lives in provider-contract.test.ts.
// This file covers only Groq-specific metadata mapping: context_window → contextLength.
describe('createGroqProvider metadata', () => {
  setupFetchMock();
  setupEnvMock('GROQ_API_KEY', 'test-key');

  it('listModelsWithMetadata maps context_window to contextLength', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'llama3-70b-8192', context_window: 8192 }] }),
        { status: 200 },
      ),
    );

    const models = await createGroqProvider().listModelsWithMetadata();
    expect(models).toEqual([{ id: 'llama3-70b-8192', contextLength: 8192 }]);
  });

  it('listModelsWithMetadata omits contextLength when context_window missing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'minimal-model' }] }), { status: 200 }),
    );

    const models = await createGroqProvider().listModelsWithMetadata();
    expect(models).toEqual([{ id: 'minimal-model' }]);
  });
});
