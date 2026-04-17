import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelId } from './model-parsing.js';
import { formatPricing, resolvePricing, LOCAL_PRICING } from './pricing-resolver.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';

describe('parseModelId', () => {
  it('parses provider/model format', () => {
    expect(parseModelId('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelName: 'claude-sonnet-4-6',
    });
  });

  it('infers anthropic from claude prefix', () => {
    expect(parseModelId('claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelName: 'claude-sonnet-4-6',
    });
  });

  it('infers openai from gpt prefix', () => {
    expect(parseModelId('gpt-5.4')).toEqual({
      provider: 'openai',
      modelName: 'gpt-5.4',
    });
  });

  it('returns null provider for unknown models', () => {
    expect(parseModelId('unknown-model-name')).toEqual({
      provider: null,
      modelName: 'unknown-model-name',
    });
  });
});

describe('formatPricing', () => {
  it('formats pricing with both values', () => {
    expect(formatPricing(3, 15)).toBe('$3/$15');
  });

  it('formats decimal values', () => {
    expect(formatPricing(0.28, 0.42)).toBe('$0.28/$0.42');
  });

  it('returns null when both values are undefined', () => {
    expect(formatPricing(undefined, undefined)).toBeNull();
  });
});

describe('resolvePricing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    modelCacheStore.reset();
  });

  it('returns LOCAL_PRICING for local providers', () => {
    expect(resolvePricing('ollama')).toEqual(LOCAL_PRICING);
    expect(resolvePricing('lm-studio')).toEqual(LOCAL_PRICING);
  });

  it('marks CLI tools as unpriced', () => {
    const pricing = resolvePricing('claude-code', undefined, 'opus');
    expect(pricing.isPriced).toBe(false);
    expect(pricing.pricingMode).toBe('unpriced-cli');
    expect(pricing.inputPer1M).toBe(0);
    expect(pricing.outputPer1M).toBe(0);
  });

  it('uses bundled fallback pricing for anthropic', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-opus-4-6');
    expect(pricing.isPriced).toBe(true);
    expect(pricing.inputPer1M).toBe(5);
    expect(pricing.outputPer1M).toBe(25);
    expect(pricing.source).toBe('bundled-fallback');
  });

  it('resolves API auto to bundled default model when available', () => {
    const pricing = resolvePricing('openai', undefined, 'auto');
    expect(pricing.isPriced).toBe(true);
    expect(pricing.name).toBe('gpt-5.4');
    expect(pricing.inputPer1M).toBe(2.5);
    expect(pricing.outputPer1M).toBe(15);
  });

  it('prefers models.dev pricing over bundled fallback', () => {
    modelCacheStore.setModelsDevCatalog({
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-opus-4-6': {
            id: 'claude-opus-4-6',
            cost: { input: 99, output: 199 },
            limit: { context: 1_000_000 },
          },
        },
      },
    });

    const pricing = resolvePricing('anthropic', modelCacheStore, 'claude-opus-4-6');
    expect(pricing.isPriced).toBe(true);
    expect(pricing.inputPer1M).toBe(99);
    expect(pricing.outputPer1M).toBe(199);
    expect(pricing.source).toBe('models-dev');
  });

  it('uses runtime provider metadata when models.dev is unavailable', () => {
    modelCacheStore.setProviderModels('anthropic', [
      { id: 'claude-opus-4-6', pricingInput: 77, pricingOutput: 177, contextLength: 1_000_000 },
    ]);

    const pricing = resolvePricing('anthropic', modelCacheStore, 'claude-opus-4-6');
    expect(pricing.isPriced).toBe(true);
    expect(pricing.inputPer1M).toBe(77);
    expect(pricing.outputPer1M).toBe(177);
    expect(pricing.source).toBe('runtime');
  });
});
