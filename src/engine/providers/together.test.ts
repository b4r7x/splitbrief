import { describe, it, expect, vi } from 'vitest';
import { createTogetherProvider } from './together.js';
import { setupFetchMock, setupEnvMock } from '#testing/helpers/fetch-mock.js';

// Shared contract (listModels / detectContextLength / error paths / overrides) lives in provider-contract.test.ts.
// This file covers only Together-specific metadata mapping: per-token → per-million pricing + isFree.
describe('createTogetherProvider metadata', () => {
  setupFetchMock();
  setupEnvMock('TOGETHER_API_KEY', 'test-key');

  it('listModelsWithMetadata converts per-token pricing to per-million and marks non-free', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'meta-llama/Llama-3-70b-chat-hf',
              context_length: 8192,
              pricing: { input: 0.0000009, output: 0.0000009 },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await createTogetherProvider().listModelsWithMetadata();
    expect(models).toEqual([
      {
        id: 'meta-llama/Llama-3-70b-chat-hf',
        contextLength: 8192,
        pricingInput: expect.closeTo(0.9, 5),
        pricingOutput: expect.closeTo(0.9, 5),
        isFree: false,
      },
    ]);
  });

  it('listModelsWithMetadata handles partial pricing (only input set)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'partial-pricing-model', context_length: 4096, pricing: { input: 0.000001 } },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await createTogetherProvider().listModelsWithMetadata();
    expect(models).toEqual([
      { id: 'partial-pricing-model', contextLength: 4096, pricingInput: 1, isFree: false },
    ]);
  });

  it('listModelsWithMetadata omits pricing fields when absent', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'minimal-model' }] }), { status: 200 }),
    );

    const models = await createTogetherProvider().listModelsWithMetadata();
    expect(models).toEqual([{ id: 'minimal-model' }]);
  });
});
