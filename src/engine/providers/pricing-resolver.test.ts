import { describe, expect, it } from 'vitest';
import {
  isApiPricedProvider,
  resolvePricing,
  getPricingMode,
  LOCAL_PRICING,
} from './pricing-resolver.js';
import { REMOTE_API_PROVIDER_IDS } from '../../core/providers/api-provider-catalog.js';
import { NULL_CACHE, type ModelCacheAccessor } from './model/resolution.js';

describe('pricing-resolver', () => {
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
    it('has no metered provider preset left in the catalog', () => {
      expect(REMOTE_API_PROVIDER_IDS).toEqual([]);
    });

    it('treats a provider outside the catalog as a pricing candidate', () => {
      expect(isApiPricedProvider('custom-endpoint')).toBe(true);
      expect(isApiPricedProvider('openrouter')).toBe(true);
    });

    it('keeps local, CLI and meta runners off the priced path', () => {
      expect(isApiPricedProvider('ollama')).toBe(false);
      expect(isApiPricedProvider('claude-code')).toBe(false);
      expect(isApiPricedProvider('shell')).toBe(false);
    });

    it('returns unpriced-local for local providers', () => {
      expect(getPricingMode('ollama')).toBe('unpriced-local');
      expect(getPricingMode('lm-studio')).toBe('unpriced-local');
    });

    it('returns unpriced-cli for CLI tools', () => {
      expect(getPricingMode('claude-code')).toBe('unpriced-cli');
    });

    it('returns unpriced-meta for meta runners (shell, agent)', () => {
      expect(getPricingMode('shell')).toBe('unpriced-meta');
      expect(getPricingMode('agent')).toBe('unpriced-meta');
    });
  });

  describe('resolvePricing with model cache', () => {
    it('returns LOCAL_PRICING for local providers, on their own provider id', () => {
      expect(resolvePricing('ollama')).toEqual({ ...LOCAL_PRICING, provider: 'ollama' });
      expect(resolvePricing('lm-studio')).toEqual({ ...LOCAL_PRICING, provider: 'lm-studio' });
    });

    it('marks CLI tools as unpriced', () => {
      const pricing = resolvePricing('claude-code', undefined, 'opus');
      expect(pricing.isPriced).toBe(false);
      expect(pricing.pricingMode).toBe('unpriced-cli');
      expect(pricing.inputPer1M).toBe(0);
      expect(pricing.outputPer1M).toBe(0);
    });

    it('leaves a custom endpoint unpriced when no catalog can rate its model', () => {
      const pricing = resolvePricing('openrouter', undefined, 'anthropic/claude-sonnet-5');
      expect(pricing.isPriced).toBe(false);
      expect(pricing.pricingMode).toBe('unpriced-unknown');
      expect(pricing.inputPer1M).toBe(0);
      expect(pricing.outputPer1M).toBe(0);
    });
  });

  describe('custom endpoint pricing follows the model', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-5': {
              id: 'claude-sonnet-5',
              cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            },
          },
        },
      }),
      getProviderModels: () => null,
    };

    it('rates a vendor-prefixed model through its vendor', () => {
      const pricing = resolvePricing('custom-endpoint', cache, 'anthropic/claude-sonnet-5');
      expect(pricing.isPriced).toBe(true);
      expect(pricing.pricingMode).toBe('api-priced');
      expect(pricing.source).toBe('models-dev');
      expect(pricing.inputPer1M).toBe(3);
      expect(pricing.outputPer1M).toBe(15);
      expect(pricing.cacheReadPer1M).toBe(0.3);
      expect(pricing.cacheWritePer1M).toBe(3.75);
    });

    it('rates a bare model id by scanning every vendor', () => {
      const pricing = resolvePricing('custom-endpoint', cache, 'claude-sonnet-5');
      expect(pricing.isPriced).toBe(true);
      expect(pricing.inputPer1M).toBe(3);
    });

    it('stays unpriced-unknown when the catalog does not list the model', () => {
      const pricing = resolvePricing('custom-endpoint', cache, 'some-private-model');
      expect(pricing.isPriced).toBe(false);
      expect(pricing.pricingMode).toBe('unpriced-unknown');
    });

    it('stays unpriced-unknown when the endpoint names no model', () => {
      const pricing = resolvePricing('custom-endpoint', cache);
      expect(pricing.isPriced).toBe(false);
      expect(pricing.pricingMode).toBe('unpriced-unknown');
    });

    it('never prices a local provider from a model rate', () => {
      expect(resolvePricing('ollama', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-local',
      });
    });

    it('never prices a CLI tool from a model rate', () => {
      expect(resolvePricing('claude-code', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-cli',
      });
    });

    it('meters an API runner by model even when its name is a CLI tool id', () => {
      const pricing = resolvePricing('api:opencode', cache, 'claude-sonnet-5');
      expect(pricing.isPriced).toBe(true);
      expect(pricing.pricingMode).toBe('api-priced');
      expect(pricing.provider).toBe('opencode');
      expect(pricing.inputPer1M).toBe(3);
    });

    it('keeps the CLI twin of that name unpriced, and a bare legacy name with it', () => {
      expect(resolvePricing('cli:opencode', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-cli',
      });
      expect(resolvePricing('opencode', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-cli',
      });
    });

    it('keeps a catalogued API provider on its catalog mode whatever its kind says', () => {
      expect(resolvePricing('api:ollama', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-local',
      });
    });

    it('leaves a custom API runner unpriced-unknown when no rate lists its model', () => {
      expect(resolvePricing('api:opencode', cache, 'some-private-model')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-unknown',
      });
    });

    it('keeps shell and agent identities off the priced path whatever they are named', () => {
      expect(resolvePricing('shell:opencode', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-meta',
      });
      expect(resolvePricing('agent:opencode', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-meta',
      });
    });

    it('never prices a removed CLI tool or runner kind a resumed run still names', () => {
      expect(isApiPricedProvider('aider')).toBe(false);
      expect(isApiPricedProvider('agent-sdk')).toBe(false);
      expect(resolvePricing('aider', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-cli',
        inputPer1M: 0,
        outputPer1M: 0,
      });
      expect(resolvePricing('agent-sdk', cache, 'claude-sonnet-5')).toMatchObject({
        isPriced: false,
        pricingMode: 'unpriced-meta',
      });
    });
  });
});
