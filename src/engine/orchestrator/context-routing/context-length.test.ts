import { describe, expect, it } from 'vitest';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { resolveProfileContextLength } from './context-length.js';

function profile(isDefault: boolean): ResolvedImplementerProfile {
  return {
    name: isDefault ? 'detected-worker' : 'sibling-worker',
    costTier: 'cheap',
    capabilities: { writesFiles: 'extracted-code' },
    isDefault,
    config: {
      kind: 'agent',
      command: isDefault ? 'detected-worker' : 'sibling-worker',
      model: 'worker-model',
    },
  };
}

describe('resolveProfileContextLength', () => {
  it('applies the boot-probed window to the default profile it was probed for', () => {
    const result = resolveProfileContextLength(profile(true), 8192, undefined, 262_144);

    expect(result).toEqual({
      contextLength: 262_144,
      source: 'detected',
      usedConservativeContextLength: false,
    });
  });

  it('leaves an unrelated sibling profile on the shared default', () => {
    const result = resolveProfileContextLength(profile(false), 8192, undefined, 262_144);

    expect(result).toEqual({
      contextLength: 8192,
      source: 'conservative-fallback',
      usedConservativeContextLength: true,
    });
  });

  it('keeps a declared window ahead of the detected value on the default profile', () => {
    const declared: ResolvedImplementerProfile = {
      ...profile(true),
      config: {
        kind: 'agent',
        command: 'detected-worker',
        model: 'worker-model',
        contextLength: 50_000,
      },
    };

    const result = resolveProfileContextLength(declared, 8192, undefined, 262_144);

    expect(result).toEqual({
      contextLength: 50_000,
      source: 'explicit',
      usedConservativeContextLength: false,
    });
  });

  it('labels a declared window equal to the detected value as detected', () => {
    const declared: ResolvedImplementerProfile = {
      ...profile(true),
      config: {
        kind: 'agent',
        command: 'detected-worker',
        model: 'worker-model',
        contextLength: 262_144,
      },
    };

    const result = resolveProfileContextLength(declared, 8192, undefined, 262_144);

    expect(result).toEqual({
      contextLength: 262_144,
      source: 'detected',
      usedConservativeContextLength: false,
    });
  });

  it('resolves a CLI profile under automatic model selection at the smallest bundled window', () => {
    const cliAuto: ResolvedImplementerProfile = {
      name: 'codex-auto',
      costTier: 'cheap',
      capabilities: { writesFiles: 'direct' },
      isDefault: false,
      config: {
        kind: 'cli',
        tool: 'codex',
        model: 'auto',
      },
    };

    const result = resolveProfileContextLength(cliAuto, DEFAULT_UNKNOWN_CONTEXT_LENGTH);

    expect(result).toEqual({
      contextLength: 272_000,
      source: 'automatic-catalog',
      usedConservativeContextLength: false,
    });
  });

  it('keeps a cache-known model ahead of the bundled catalog', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: { 'gpt-5.2-codex': { id: 'gpt-5.2-codex', limit: { context: 400_000 } } },
      },
    };
    const cliPinned: ResolvedImplementerProfile = {
      name: 'codex-pinned',
      costTier: 'cheap',
      capabilities: { writesFiles: 'direct' },
      isDefault: false,
      config: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.2-codex',
      },
    };

    const result = resolveProfileContextLength(
      cliPinned,
      DEFAULT_UNKNOWN_CONTEXT_LENGTH,
      makeModelCacheAccessor({ catalog }),
    );

    expect(result).toEqual({
      contextLength: 400_000,
      source: 'models-dev',
      usedConservativeContextLength: false,
    });
  });
});
