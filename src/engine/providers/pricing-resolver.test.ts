import { describe, expect, it } from 'vitest';
import { resolvePricing, isApiPricedProvider, getPricingMode } from './pricing-resolver.js';
import { NULL_CACHE } from './model-resolution.js';

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
      expect(result.cacheReadPer1M).toBe(0.30);
      expect(result.cacheWritePer1M).toBe(3.75);
    });

    it('resolvePricing for claude-opus-4-6 returns verified cache prices', () => {
      const result = resolvePricing('anthropic', NULL_CACHE, 'claude-opus-4-6');
      expect(result.isPriced).toBe(true);
      expect(result.cacheReadPer1M).toBe(0.50);
      expect(result.cacheWritePer1M).toBe(6.25);
    });

    it('resolvePricing for non-Anthropic priced model returns undefined cache pricing fields', () => {
      const result = resolvePricing('deepseek', NULL_CACHE, 'deepseek-chat');
      expect(result.isPriced).toBe(true);
      expect(result.cacheReadPer1M).toBeUndefined();
      expect(result.cacheWritePer1M).toBeUndefined();
    });
  });
});
