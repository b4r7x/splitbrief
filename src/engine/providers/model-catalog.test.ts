import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModelCatalog } from './model-catalog.js';
import { modelCacheStore } from '../../stores/model-cache.js';

describe('resolveModelCatalog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    modelCacheStore.reset();
  });

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
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('claude-code', modelCacheStore);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-opus-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-haiku-4-5')).toBe(false);
  });

  it('hydrates anthropic catalog from models.dev first', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('anthropic', modelCacheStore);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((entry) => entry.id === 'claude-opus-4-6')).toBe(true);
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingInput).toBe(3);
  });

  it('includes bundled agent-sdk models without pricing (agent-sdk is unpriced-meta)', () => {
    // agent-sdk is classified as unpriced-meta — pricing is stripped from catalog entries.
    // Bundled models from KNOWN_MODELS are still present for model selection purposes.
    const models = resolveModelCatalog('agent-sdk', modelCacheStore);
    expect(models.some((entry) => entry.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingInput).toBeUndefined();
    expect(models.find((entry) => entry.id === 'claude-sonnet-4-6')?.pricingMode).toBe('unpriced-meta');
  });

  it('hydrates codex catalog from filtered openai models.dev entries', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('codex', modelCacheStore);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'gpt-5.1-codex-max')).toBe(true);
    expect(models.some((entry) => entry.id === 'text-embedding-3-large')).toBe(false);
  });

  it('includes runtime-discovered CLI models alongside bundled fallback entries', () => {
    modelCacheStore.setProviderModels('opencode', [{ id: 'google/gemini-2.5-pro' }]);

    const models = resolveModelCatalog('opencode', modelCacheStore);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'google/gemini-2.5-pro')).toBe(true);
  });

  it('hydrates opencode catalog from direct models.dev provider data', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('opencode', modelCacheStore);
    expect(models.some((entry) => entry.id === 'auto')).toBe(true);
    expect(models.some((entry) => entry.id === 'anthropic/claude-sonnet-4.6')).toBe(true);
    expect(models.find((entry) => entry.id === 'anthropic/claude-sonnet-4.6')?.source).toBe('models-dev');
  });

  it('hydrates copilot and kilo-code catalogs from direct models.dev providers', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const copilotModels = resolveModelCatalog('copilot', modelCacheStore);
    const kiloModels = resolveModelCatalog('kilo-code', modelCacheStore);

    expect(copilotModels.some((entry) => entry.id === 'claude-opus-4.6')).toBe(true);
    expect(copilotModels.find((entry) => entry.id === 'claude-opus-4.6')?.source).toBe('models-dev');
    expect(kiloModels.some((entry) => entry.id === 'kimi-k2.5')).toBe(true);
    expect(kiloModels.find((entry) => entry.id === 'kimi-k2.5')?.source).toBe('models-dev');
  });

  it('filters stale bundled entries when models.dev data is available', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('anthropic', modelCacheStore);
    expect(models.some((e) => e.id === 'claude-sonnet-4-6')).toBe(true);
    expect(models.some((e) => e.id === 'claude-opus-4-6')).toBe(false);
    const defaultEntry = models.find((e) => e.isDefault);
    expect(defaultEntry).toBeDefined();
  });

  it('propagates releaseDate from models.dev through catalog', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('anthropic', modelCacheStore);
    const sonnet = models.find((e) => e.id === 'claude-sonnet-4-6');
    expect(sonnet?.releaseDate).toBe('2026-02-15');
  });

  it('models.dev context length overrides bundled fallback', () => {
    modelCacheStore.setModelsDevCatalog({
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
    });

    const models = resolveModelCatalog('anthropic', modelCacheStore);
    const sonnet = models.find((e) => e.id === 'claude-sonnet-4-6');
    expect(sonnet?.contextLength).toBe(500_000);
  });
});
