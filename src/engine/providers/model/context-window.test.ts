import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { resolveRunnerContextWindow } from './context-window.js';

describe('resolveRunnerContextWindow', () => {
  it('resolves a CLI tool under automatic model selection to the smallest bundled window', () => {
    const result = resolveRunnerContextWindow({ providerId: 'aider', model: 'auto' });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'automatic-catalog' });
  });

  it('resolves an explicitly pinned unknown model to nothing', () => {
    const result = resolveRunnerContextWindow({ providerId: 'codex', model: 'some-unknown-model' });

    expect(result).toBeNull();
  });

  it('does not match a provider-qualified selection id against a bundled row', () => {
    const result = resolveRunnerContextWindow({
      providerId: 'deepseek',
      model: 'deepseek/deepseek-v4-pro',
    });

    expect(result).toBeNull();
  });

  it('prefers a cache-known model over the bundled row', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            limit: { context: 400_000 },
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const result = resolveRunnerContextWindow({ providerId: 'anthropic', model: 'auto', cache });

    expect(result).toEqual({ contextLength: 400_000, source: 'models-dev' });
  });

  it('resolves a codex/auto implementer to its real window, not the conservative fallback', () => {
    const result = resolveRunnerContextWindow({ providerId: 'codex', model: 'auto' });

    expect(result).toEqual({ contextLength: 1_050_000, source: 'automatic-catalog' });
  });
});
