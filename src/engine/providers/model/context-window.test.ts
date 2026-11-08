import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { resolveRunnerContextWindow } from './context-window.js';

describe('resolveRunnerContextWindow', () => {
  it('resolves a CLI tool under automatic model selection to the smallest bundled window', () => {
    const result = resolveRunnerContextWindow({ providerId: 'opencode', model: 'auto' });

    expect(result).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });

  it('resolves a claude-code/auto seat to the smallest window its aliases declare', () => {
    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'auto' });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'automatic-catalog' });
  });

  // A pinned alias is the ordinary claude-code seat, and no catalog publishes a row called
  // `opus` — only `claude-opus-5`, which the alias names. No lane maps the alias onto that row,
  // so the bundled row's own window answers even with a catalog loaded.
  it('answers a pinned claude-code alias from its bundled row even when a catalog is loaded', () => {
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

    expect(result).toEqual({ contextLength: 1_000_000, source: 'known-catalog' });
  });

  it('answers a pinned claude-code alias from its own declared window', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-haiku-5-5': { id: 'claude-haiku-5-5', limit: { context: 500_000 } } },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const result = resolveRunnerContextWindow({ providerId: 'claude-code', model: 'haiku', cache });

    expect(result).toEqual({ contextLength: 1_000_000, source: 'known-catalog' });
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

  it('resolves a pinned api model through the models.dev cache', () => {
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

    const result = resolveRunnerContextWindow({
      providerId: 'ollama',
      model: 'qwen3-coder:30b',
      cache,
    });

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

describe('resolveRunnerContextWindow — kind-aware lanes', () => {
  it('never budgets a CLI-named custom API provider against the local CLI catalog', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [{ id: 'opencode/gpt-5', contextLength: 999_000 }],
      },
    });

    // Legacy callers keep the name-only lane choice.
    expect(
      resolveRunnerContextWindow({ providerId: 'opencode', model: 'opencode/gpt-5', cache }),
    ).toEqual({ contextLength: 999_000, source: 'runtime' });

    // The API seat of that name is a custom endpoint with no catalog identity.
    expect(
      resolveRunnerContextWindow({
        providerId: 'opencode',
        model: 'opencode/gpt-5',
        kind: 'api',
        cache,
      }),
    ).toBeNull();
  });

  it('keeps a catalogued API provider on its API lanes and a CLI tool on its own', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: { 'qwen3-coder:30b': { id: 'qwen3-coder:30b', limit: { context: 400_000 } } },
        },
      },
    });

    expect(
      resolveRunnerContextWindow({
        providerId: 'ollama',
        model: 'qwen3-coder:30b',
        kind: 'api',
        cache,
      }),
    ).toEqual({ contextLength: 400_000, source: 'models-dev' });
    expect(resolveRunnerContextWindow({ providerId: 'codex', model: 'auto', kind: 'cli' })).toEqual(
      { contextLength: 272_000, source: 'automatic-catalog' },
    );
    expect(
      resolveRunnerContextWindow({ providerId: 'codex', model: 'auto', kind: 'shell' }),
    ).toBeNull();
  });
});

describe('resolveRunnerContextWindow — a CLI seat with its tool listing', () => {
  // codex 0.164.0 `debug models` lists gpt-6.1-sol at 500000; models.dev `openai` says 272000.
  it("answers a pinned codex model from the tool's own listing, not models.dev", () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: { 'gpt-6.1-sol': { id: 'gpt-6.1-sol', limit: { context: 272_000 } } },
        },
      },
      providerModels: { codex: [{ id: 'gpt-6.1-sol', contextLength: 500_000 }] },
    });

    expect(
      resolveRunnerContextWindow({ providerId: 'codex', kind: 'cli', model: 'gpt-6.1-sol', cache }),
    ).toEqual({ contextLength: 500_000, source: 'runtime' });
  });

  it('keeps the smallest bundled window for an automatic OpenCode seat whatever its listing holds', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          { id: 'openai/gpt-5.6-luna', contextLength: 1_050_000 },
          { id: 'opencode-go/qwen3.7-max', contextLength: 1_000_000 },
          { id: 'opencode-go/glm-5.2', contextLength: 128_000 },
        ],
      },
    });

    expect(
      resolveRunnerContextWindow({ providerId: 'opencode', kind: 'cli', model: 'auto', cache }),
    ).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });

  // opencode `/api/model` lists three OpenAI embedding rows at 8191 and 8192.
  it('an embedding row never sets the window of an automatic seat', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          {
            id: 'openai/text-embedding-3-small',
            contextLength: 8191,
            capabilities: ['type:embedding'],
            supportsToolCalls: false,
          },
          { id: 'opencode-go/glm-5.2', contextLength: 128_000 },
          { id: 'openai/gpt-5.6-sol', contextLength: 1_050_000 },
        ],
      },
    });

    expect(
      resolveRunnerContextWindow({ providerId: 'opencode', kind: 'cli', model: 'auto', cache }),
    ).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });

  // `kilo models --verbose` lists kilo/openai/gpt-3.5-turbo-0613 at 4095 among 321 rows.
  it('one small chat row never sets the window of an automatic seat', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'kilo-code': [
          { id: 'kilo/openai/gpt-3.5-turbo-0613', contextLength: 4095 },
          { id: 'kilo/~anthropic/claude-fable-latest', contextLength: 1_000_000 },
        ],
      },
    });

    expect(
      resolveRunnerContextWindow({ providerId: 'kilo-code', kind: 'cli', model: 'auto', cache }),
    ).toBeNull();
  });

  it('keeps the smallest bundled window for an automatic seat whose tool lists nothing', () => {
    expect(
      resolveRunnerContextWindow({
        providerId: 'opencode',
        kind: 'cli',
        model: 'auto',
        cache: makeModelCacheAccessor(),
      }),
    ).toEqual({ contextLength: 272_000, source: 'automatic-catalog' });
  });
});
