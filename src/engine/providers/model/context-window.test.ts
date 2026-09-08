import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { resolveRunnerContextWindow } from './context-window.js';

describe('resolveRunnerContextWindow', () => {
  it('resolves a CLI tool under automatic model selection to the smallest bundled window', () => {
    const result = resolveRunnerContextWindow({ providerId: 'opencode', model: 'auto' });

    expect(result).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });

  // `auto` names no model, so the seat is floored at the smallest window the tool's own aliases
  // declare — `haiku`'s 200 000, the one every model Claude could pick is guaranteed to have.
  it('resolves a claude-code/auto seat to the smallest window its aliases declare', () => {
    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'auto' });

    expect(result).toEqual({ contextLength: 200_000, source: 'automatic-catalog' });
  });

  // A pinned alias is the ordinary claude-code seat, and no catalog publishes a row called
  // `opus` — only `claude-opus-5`, which the alias names. Reading the alias verbatim and giving
  // up drops a 1M seat to the 32 768-token conservative fallback.
  it('resolves a pinned claude-code alias through the catalog row it names', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-opus-5': { id: 'claude-opus-5', limit: { context: 1_000_000 } },
        },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'opus', cache });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'models-dev' });
  });

  // Every alias declares the window Claude bakes for it, and models.dev re-publishes the same
  // number. The catalog is the one that stays current, so it outranks the declaration — here it
  // says 500 000 and the pinned seat must follow it rather than its own 200 000.
  it('lets the catalog outrank the window an alias declares', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 500_000 } } },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'haiku', cache });

    expect(result).toEqual({ contextLength: 500_000, source: 'models-dev' });
  });

  // The first run of every session reaches here: no catalog has loaded yet. The alias's own
  // declared window is what keeps a 1M seat from budgeting as if it were Haiku.
  it('answers a pinned claude-code alias from its own window when no catalog answers', () => {
    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'opus' });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'known-catalog' });
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
      ollama: {
        id: 'ollama',
        models: {
          'qwen3-coder:30b': {
            id: 'qwen3-coder:30b',
            limit: { context: 400_000 },
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const result = resolveRunnerContextWindow({ providerId: 'ollama', model: 'auto', cache });

    expect(result).toEqual({ contextLength: 400_000, source: 'models-dev' });
  });

  it('resolves a codex/auto implementer to its real window, not the conservative fallback', () => {
    const result = resolveRunnerContextWindow({ providerId: 'codex', model: 'auto' });

    expect(result).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });

  // The floor rose deliberately (SPEC-D9) from 272 000, and neither number is copilot's true
  // guaranteed minimum: models.dev `github-copilot` serves `claude-haiku-4.5` at 200 000, so the
  // honest fix is a third bundled row — kept out of scope by decisions.md D-5.
  it('floors a copilot/auto seat at the smaller of the two windows its bundled pair declares', () => {
    const result = resolveRunnerContextWindow({ providerId: 'copilot', model: 'auto' });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'automatic-catalog' });
  });

  // The first run of every session reaches here: no catalog has loaded yet, so the bundled row
  // is what answers — the price tier never carries the window.
  it('answers a pinned copilot model from the window models.dev publishes, not its price tier', () => {
    const result = resolveRunnerContextWindow({ providerId: 'copilot', model: 'gpt-5.6-sol' });

    expect(result).toEqual({ contextLength: 1_050_000, source: 'known-catalog' });
  });
});
