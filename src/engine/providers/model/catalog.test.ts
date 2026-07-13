import { describe, expect, it } from 'vitest';
import { lookupCatalogContextLength, resolveModelCatalog } from './catalog.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('resolveModelCatalog', () => {
  it('returns Claude Code aliases instead of stale pinned fallbacks', () => {
    const ids = resolveModelCatalog('claude-code').map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(['auto', 'sonnet', 'opus', 'opusplan']));
    expect(ids).not.toContain('default');
    expect(ids).not.toContain('claude-opus-4-1-20250805');
  });

  it('keeps Claude Code entries unpriced in the picker catalog', () => {
    const entry = resolveModelCatalog('claude-code').find((item) => item.id === 'sonnet');
    expect(entry?.pricingInput).toBeUndefined();
    expect(entry?.pricingOutput).toBeUndefined();
    expect(entry?.pricingMode).toBe('unpriced-cli');
  });

  it('hydrates Claude Code catalog from anthropic models.dev entries', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 1_000_000 },
            },
            'claude-opus-4-6': {
              id: 'claude-opus-4-6',
              cost: { input: 5, output: 25 },
              limit: { context: 1_000_000 },
            },
            'claude-haiku-4-5': {
              id: 'claude-haiku-4-5',
              cost: { input: 1, output: 5 },
              limit: { context: 200_000 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('claude-code', cache);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-opus-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-haiku-4-5')).toBe(false);
  });

  it('hydrates anthropic catalog from models.dev first', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 1_000_000 },
            },
            'claude-opus-4-6': {
              id: 'claude-opus-4-6',
              cost: { input: 5, output: 25 },
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('anthropic', cache);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-opus-4-6')).toBe(true);
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingInput).toBe(3);
  });

  it('includes bundled agent-sdk models without pricing (agent-sdk is unpriced-meta)', () => {
    // agent-sdk is classified as unpriced-meta — pricing is stripped from catalog entries.
    // Bundled models from KNOWN_MODELS are still present for model selection purposes.
    const cache = makeModelCacheAccessor();
    const models = resolveModelCatalog('agent-sdk', cache);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingInput).toBeUndefined();
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingMode).toBe(
      'unpriced-meta',
    );
  });

  it('hydrates codex catalog from filtered openai models.dev entries', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: {
            'gpt-5.4': {
              id: 'gpt-5.4',
              cost: { input: 2.5, output: 15 },
              limit: { context: 400_000 },
            },
            'gpt-5.1-codex-max': {
              id: 'gpt-5.1-codex-max',
              cost: { input: 1.25, output: 10 },
              limit: { context: 400_000 },
            },
            'text-embedding-3-large': {
              id: 'text-embedding-3-large',
              cost: { input: 0.13, output: 0 },
              limit: { context: 8_191 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('codex', cache);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'gpt-5.1-codex-max')).toBe(true);
    expect(models.some((entry) => entry.id === 'text-embedding-3-large')).toBe(false);
  });

  it('includes runtime-discovered CLI models alongside bundled fallback entries', () => {
    const cache = makeModelCacheAccessor({
      providerModels: { opencode: [{ id: 'google/gemini-2.5-pro' }] },
    });

    const models = resolveModelCatalog('opencode', cache);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'google/gemini-2.5-pro')).toBe(true);
  });

  it('hydrates opencode catalog from direct models.dev provider data', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        opencode: {
          id: 'opencode',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('opencode', cache);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'anthropic/claude-sonnet-4.6')).toBe(true);
    expect(models.find((entry) => entry.id === 'anthropic/claude-sonnet-4.6')?.source).toBe(
      'models-dev',
    );
  });

  it('hydrates copilot and kilo-code catalogs from direct models.dev providers', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        'github-copilot': {
          id: 'github-copilot',
          models: {
            'claude-opus-4.6': {
              id: 'claude-opus-4.6',
              cost: { input: 0, output: 0 },
              limit: { context: 1_000_000 },
            },
          },
        },
        kilo: {
          id: 'kilo',
          models: {
            'kimi-k2.5': {
              id: 'kimi-k2.5',
              cost: { input: 0, output: 0 },
              limit: { context: 256_000 },
            },
          },
        },
      },
    });

    const copilotModels = resolveModelCatalog('copilot', cache);
    const kiloModels = resolveModelCatalog('kilo-code', cache);

    expect(copilotModels.some((entry) => entry.id === 'claude-opus-4.6')).toBe(true);
    expect(copilotModels.find((entry) => entry.id === 'claude-opus-4.6')?.source).toBe(
      'models-dev',
    );
    expect(kiloModels.some((entry) => entry.id === 'kimi-k2.5')).toBe(true);
    expect(kiloModels.find((entry) => entry.id === 'kimi-k2.5')?.source).toBe('models-dev');
  });

  it('filters stale bundled entries when models.dev data is available', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('anthropic', cache);
    expect(models.some((e) => e.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((e) => e.id === 'claude-opus-4-6')).toBe(false);
    const defaultEntry = models.find((e) => e.isDefault);
    expect(defaultEntry).toBeDefined();
  });

  it('propagates releaseDate from models.dev through catalog', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 1_000_000 },
              release_date: '2025-10-01',
              last_updated: '2026-02-15',
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('anthropic', cache);
    const sonnet = models.find((e) => e.id === 'claude-sonnet-4-6');
    expect(sonnet?.releaseDate).toBe('2026-02-15');
  });

  it('models.dev context length overrides bundled fallback', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-6': {
              id: 'claude-sonnet-4-6',
              cost: { input: 3, output: 15 },
              limit: { context: 500_000 },
            },
          },
        },
      },
    });

    const models = resolveModelCatalog('anthropic', cache);
    const sonnet = models.find((e) => e.id === 'claude-sonnet-4-6');
    expect(sonnet?.contextLength).toBe(500_000);
  });
});

describe('lookupCatalogContextLength', () => {
  it('looks up context length by comparable catalog keys', () => {
    expect(lookupCatalogContextLength('deepseek', 'deepseek/deepseek-chat')).toBe(128_000);
  });

  it('returns undefined for an unknown provider', () => {
    expect(lookupCatalogContextLength('unknown-provider', 'deepseek-chat')).toBeUndefined();
  });
});
