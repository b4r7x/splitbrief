import { describe, expect, it } from 'vitest';
import {
  resolvePricing,
  isApiPricedProvider,
  getPricingMode,
  LOCAL_PRICING,
} from './pricing-resolver.js';
import { NULL_CACHE } from './model/resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('pricing-resolver', () => {
  describe('agent-sdk classification', () => {
    it('is NOT classified as an api-priced provider', () => {
      expect(isApiPricedProvider('agent-sdk')).toBe(false);
    });

    it('resolves to unpriced-meta (not api-priced or unpriced-unknown)', () => {
      const result = resolvePricing('agent-sdk', NULL_CACHE);
      expect(result.isPriced).toBe(false);
      expect(result.pricingMode).toBe('unpriced-meta');
      expect(result.isLocal).toBe(false);
    });
  });

  describe('agent meta runner classification', () => {
    it('resolves to unpriced-meta', () => {
      const result = resolvePricing('agent', NULL_CACHE);
      expect(result.isPriced).toBe(false);
      expect(result.pricingMode).toBe('unpriced-meta');
    });
  });

  describe('shell meta runner classification', () => {
    it('resolves to unpriced-meta', () => {
      const result = resolvePricing('shell', NULL_CACHE);
      expect(result.isPriced).toBe(false);
      expect(result.pricingMode).toBe('unpriced-meta');
    });
  });

  describe('getPricingMode', () => {
    it('returns api-priced for cloud API providers', () => {
      expect(getPricingMode('anthropic')).toBe('api-priced');
      expect(getPricingMode('openrouter')).toBe('api-priced');
    });

    it('returns unpriced-local for local providers', () => {
      expect(getPricingMode('ollama')).toBe('unpriced-local');
      expect(getPricingMode('lm-studio')).toBe('unpriced-local');
    });

    it('returns unpriced-cli for CLI tools', () => {
      expect(getPricingMode('claude-code')).toBe('unpriced-cli');
    });

    it('returns unpriced-meta for meta runners (shell, agent, agent-sdk)', () => {
      expect(getPricingMode('shell')).toBe('unpriced-meta');
      expect(getPricingMode('agent')).toBe('unpriced-meta');
      expect(getPricingMode('agent-sdk')).toBe('unpriced-meta');
    });
  });

  describe('cache pricing in bundled catalog', () => {
    it('resolvePricing for claude-sonnet-4-6 returns verified cache prices', () => {
      const result = resolvePricing('anthropic', NULL_CACHE, 'claude-sonnet-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.cacheReadPer1M).toBe(0.3);
      expect(result.cacheWritePer1M).toBe(3.75);
    });

    it('resolvePricing for claude-opus-4-6 returns verified cache prices', () => {
      const result = resolvePricing('anthropic', NULL_CACHE, 'claude-opus-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.cacheReadPer1M).toBe(0.5);
      expect(result.cacheWritePer1M).toBe(6.25);
    });

    it('resolvePricing for non-Anthropic priced model returns undefined cache pricing fields', () => {
      const result = resolvePricing('deepseek', NULL_CACHE, 'deepseek-chat');
      expect(result.isPriced).toBe(true);
      expect(result.cacheReadPer1M).toBeUndefined();
      expect(result.cacheWritePer1M).toBeUndefined();
    });

    it('merges bundled cache pricing when runtime catalog provides pricing without cache fields', () => {
      // Simulate a runtime model cache entry for anthropic/claude-sonnet-4-6 with pricing
      // but no cache rates. We expect resolvePricing to merge the bundled fallback's verified
      // cache rates so cost math stays cache-aware.
      const cache = makeModelCacheAccessor({
        providerModels: {
          anthropic: [{ id: 'claude-sonnet-4-6', pricingInput: 3, pricingOutput: 15 }],
        },
      });
      const result = resolvePricing('anthropic', cache, 'claude-sonnet-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.source).toBe('runtime');
      expect(result.cacheReadPer1M).toBe(0.3);
      expect(result.cacheWritePer1M).toBe(3.75);
    });

    it('prefers models.dev catalog cache rates over the bundled fallback', () => {
      const cache = makeModelCacheAccessor({
        catalog: {
          anthropic: {
            id: 'anthropic',
            models: {
              'claude-sonnet-4-6': {
                id: 'claude-sonnet-4-6',
                cost: { input: 3, output: 15, cache_read: 0.11, cache_write: 1.22 },
                limit: { context: 1_000_000 },
              },
            },
          },
        },
      });
      const result = resolvePricing('anthropic', cache, 'claude-sonnet-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.source).toBe('models-dev');
      expect(result.cacheReadPer1M).toBe(0.11);
      expect(result.cacheWritePer1M).toBe(1.22);
    });

    it('prefers runtime catalog cache rates over the bundled fallback', () => {
      const cache = makeModelCacheAccessor({
        providerModels: {
          anthropic: [
            {
              id: 'claude-sonnet-4-6',
              pricingInput: 3,
              pricingOutput: 15,
              pricingCacheRead: 0.22,
              pricingCacheWrite: 2.44,
            },
          ],
        },
      });
      const result = resolvePricing('anthropic', cache, 'claude-sonnet-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.source).toBe('runtime');
      expect(result.cacheReadPer1M).toBe(0.22);
      expect(result.cacheWritePer1M).toBe(2.44);
    });
  });

  describe('resolvePricing with model cache', () => {
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
      const cache = makeModelCacheAccessor({
        catalog: {
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
        },
      });

      const pricing = resolvePricing('anthropic', cache, 'claude-opus-4-6');
      expect(pricing.isPriced).toBe(true);
      expect(pricing.inputPer1M).toBe(99);
      expect(pricing.outputPer1M).toBe(199);
      expect(pricing.source).toBe('models-dev');
    });

    it('carries models.dev context pricing tiers', () => {
      const cache = makeModelCacheAccessor({
        catalog: {
          openai: {
            id: 'openai',
            models: {
              'gpt-5.4': {
                id: 'gpt-5.4',
                cost: {
                  input: 2.5,
                  output: 15,
                  cache_read: 0.25,
                  tiers: [
                    {
                      input: 5,
                      output: 22.5,
                      cache_read: 0.5,
                      tier: { type: 'context', size: 272000 },
                    },
                  ],
                },
              },
            },
          },
        },
      });

      const pricing = resolvePricing('openai', cache, 'gpt-5.4');
      expect(pricing.source).toBe('models-dev');
      expect(pricing.pricingTiers).toEqual([
        {
          type: 'context',
          thresholdTokens: 272000,
          inputPer1M: 5,
          outputPer1M: 22.5,
          cacheReadPer1M: 0.5,
        },
      ]);
    });

    it('uses runtime provider metadata when models.dev is unavailable', () => {
      const cache = makeModelCacheAccessor({
        providerModels: {
          anthropic: [
            {
              id: 'claude-opus-4-6',
              pricingInput: 77,
              pricingOutput: 177,
              contextLength: 1_000_000,
            },
          ],
        },
      });

      const pricing = resolvePricing('anthropic', cache, 'claude-opus-4-6');
      expect(pricing.isPriced).toBe(true);
      expect(pricing.inputPer1M).toBe(77);
      expect(pricing.outputPer1M).toBe(177);
      expect(pricing.source).toBe('runtime');
    });
  });
});
