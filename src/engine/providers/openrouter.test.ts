import { describe, it, expect, vi } from 'vitest';
import { createOpenRouterProvider, parsePrice, toDetectedModel } from './openrouter.js';
import { setupFetchMock, setupEnvMock } from '#testing/helpers/fetch-mock.js';

// Shared provider contract (listModels / detectContextLength / error paths / overrides)
// lives in provider-contract.test.ts. This file covers OpenRouter-specific pure helpers
// (price parsing, model→DetectedModel transformation) and the metadata fetch shape.

describe('parsePrice', () => {
  it('returns 0 for undefined', () => {
    expect(parsePrice(undefined)).toBe(0);
  });

  it('returns 0 for "0"', () => {
    expect(parsePrice('0')).toBe(0);
  });

  it('converts per-token price to per-1M tokens', () => {
    // 0.000005 per token = 5 per 1M tokens
    expect(parsePrice('0.000005')).toBe(5);
  });

  it('handles larger prices', () => {
    // 0.015 per token = 15000 per 1M tokens
    expect(parsePrice('0.015')).toBe(15000);
  });

  it('returns 0 for invalid string', () => {
    expect(parsePrice('not-a-number')).toBe(0);
  });
});

describe('toDetectedModel', () => {
  it('detects FREE models by :free suffix', () => {
    const model = toDetectedModel({
      id: 'meta-llama/llama-3-8b-instruct:free',
      context_length: 8192,
      pricing: { prompt: '0.001', completion: '0.002' },
    });

    expect(model.isFree).toBe(true);
    expect(model.id).toBe('meta-llama/llama-3-8b-instruct:free');
  });

  it('detects FREE models by zero pricing', () => {
    const model = toDetectedModel({
      id: 'some-model/free-model',
      context_length: 4096,
      pricing: { prompt: '0', completion: '0' },
    });

    expect(model.isFree).toBe(true);
  });

  it('marks non-free models correctly', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      context_length: 128000,
      pricing: { prompt: '0.000005', completion: '0.000015' },
    });

    expect(model.isFree).toBe(false);
    expect(model.pricingInput).toBe(5);
    expect(model.pricingOutput).toBe(15);
  });

  it('extracts context_length', () => {
    const model = toDetectedModel({
      id: 'anthropic/claude-3-opus',
      context_length: 200000,
    });

    expect(model.contextLength).toBe(200000);
  });

  it('extracts vision capability from architecture', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      architecture: {
        modality: {
          input: ['text', 'image'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toEqual(['vision']);
  });

  it('returns undefined capabilities when no image input', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4',
      architecture: {
        modality: {
          input: ['text'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toBeUndefined();
  });

  it('handles missing optional fields', () => {
    const model = toDetectedModel({ id: 'minimal-model' });

    expect(model.id).toBe('minimal-model');
    expect(model.contextLength).toBeUndefined();
    expect(model.pricingInput).toBe(0);
    expect(model.pricingOutput).toBe(0);
    expect(model.isFree).toBe(true); // zero pricing = free
    expect(model.capabilities).toBeUndefined();
  });
});

describe('createOpenRouterProvider listModelsWithMetadata', () => {
  setupFetchMock();
  setupEnvMock('OPENROUTER_API_KEY', 'test-key');

  it('returns full metadata with pricing conversion and vision capability', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o',
              context_length: 128000,
              pricing: { prompt: '0.000005', completion: '0.000015' },
              architecture: { modality: { input: ['text', 'image'], output: ['text'] } },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await createOpenRouterProvider().listModelsWithMetadata();
    expect(models).toEqual([
      {
        id: 'openai/gpt-4o',
        contextLength: 128000,
        pricingInput: 5,
        pricingOutput: 15,
        isFree: false,
        capabilities: ['vision'],
      },
    ]);
  });
});
