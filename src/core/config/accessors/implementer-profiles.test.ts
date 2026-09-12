import { describe, expect, it } from 'vitest';
import {
  blendedPricePer1M,
  resolveImplementerProfiles,
  withAutoRouteProfiles,
  withoutImplementerProfiles,
} from './implementer-profiles.js';
import { createDefaultConfig } from '../load/defaults.js';
import { ImplementerProfileNameSchema } from '../../schemas/implementer-config.js';
import type { Config } from '../../schemas/config.js';
import type { AutoRouteCandidateRow } from './implementer-profiles.js';

function configWithProfiles(profiles: NonNullable<Config['implementerProfiles']>): Config {
  return {
    ...createDefaultConfig(),
    implementerProfiles: profiles,
  };
}

describe('resolveImplementerProfiles', () => {
  it('returns a stable default profile for single implementer configs', () => {
    const config = createDefaultConfig();

    const resolved = resolveImplementerProfiles(config);

    expect(resolved.defaultProfile).toMatchObject({
      name: 'default',
      label: 'Default implementer',
      costTier: 'unknown',
      capabilities: { writesFiles: 'extracted-code' },
      config: config.implementer,
      isDefault: true,
    });
    expect(resolved.profiles).toHaveLength(1);
  });

  it('returns profiles in stable name order and marks the configured default', () => {
    const config = configWithProfiles({
      default: 'local-qwen',
      profiles: {
        'cloud-cheap': {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
          model: 'qwen/qwen3-coder',
          contextLength: 131072,
          label: 'Cheap cloud',
          costTier: 'cheap',
        },
        'local-qwen': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
          contextLength: 32768,
          costTier: 'local',
        },
      },
    });

    const resolved = resolveImplementerProfiles(config);

    expect(resolved.profiles.map((profile) => profile.name)).toEqual(['cloud-cheap', 'local-qwen']);
    expect(resolved.defaultProfile.name).toBe('local-qwen');
    expect(
      resolved.profiles.map((profile) => [profile.name, profile.capabilities.writesFiles]),
    ).toEqual([
      ['cloud-cheap', 'extracted-code'],
      ['local-qwen', 'extracted-code'],
    ]);
    expect(resolved.defaultProfile.config).toEqual({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      contextLength: 32768,
    });
  });

  it('falls back to the first sorted profile when default is omitted', () => {
    const config = configWithProfiles({
      profiles: {
        'z-local': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'z-model',
        },
        'a-local': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'a-model',
        },
      },
    });

    const resolved = resolveImplementerProfiles(config);

    expect(resolved.defaultProfile.name).toBe('a-local');
    expect(resolved.profiles.map((profile) => [profile.name, profile.isDefault])).toEqual([
      ['a-local', true],
      ['z-local', false],
    ]);
  });

  it('derives direct-write capability metadata for direct runner profiles', () => {
    const config = configWithProfiles({
      profiles: {
        'agent-cli': {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5-mini',
          contextLength: 200000,
          costTier: 'standard',
        },
      },
    });

    const resolved = resolveImplementerProfiles(config);

    expect(resolved.defaultProfile.capabilities).toEqual({ writesFiles: 'direct' });
    expect(resolved.defaultProfile.config).toEqual({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5-mini',
      contextLength: 200000,
    });
  });
});

describe('auto:cheapest profile derivation', () => {
  const proRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro', contextLength: 200000 },
    pricingInput: 0.25,
    pricingOutput: 1.0,
  };
  const maxRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/max' },
    pricingInput: 2,
    pricingOutput: 10,
  };
  const commandRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
  };
  const autoCheapestConfig: Config = {
    ...createDefaultConfig(),
    implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
  };

  function derive(candidates: readonly AutoRouteCandidateRow[], config = autoCheapestConfig) {
    return resolveImplementerProfiles(withAutoRouteProfiles(config, candidates));
  }

  it('derives priced candidates ranked by blended cost and marks the cheapest default', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [maxRow, commandRow, proRow]);
    const resolved = resolveImplementerProfiles(routed);

    expect(resolved.profiles).toHaveLength(2);
    expect(resolved.defaultProfile.config.model).toBe('kilo/kilo-auto/pro');
    const priced = Object.values(routed.implementerProfiles?.profiles ?? {});
    expect(priced.map((row) => row.pricePer1M)).toEqual([4.25, 42]);
    for (const profile of resolved.profiles) {
      expect(profile.name).toMatch(/^auto-kilo-code-kilo-kilo-auto-/);
      expect(ImplementerProfileNameSchema.safeParse(profile.name).success).toBe(true);
      expect(profile.costTier).toBe('unknown');
      expect(profile.capabilities.writesFiles).toBe('direct');
    }
    expect(resolved.defaultProfile.label).toContain('$4.25/1M');
  });

  it('ranks a free api candidate first and sanitizes its model into the profile name', () => {
    const ollamaRow: AutoRouteCandidateRow = {
      config: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
      },
      pricingInput: 0,
      pricingOutput: 0,
    };

    const resolved = derive([proRow, ollamaRow]);

    expect(resolved.defaultProfile.name).toMatch(/^auto-ollama-qwen3-coder-30b/);
    expect(resolved.defaultProfile.pricePer1M).toBe(0);
    expect(resolved.defaultProfile.capabilities.writesFiles).toBe('extracted-code');
  });

  it('keeps the static profile when no candidate carries a price', () => {
    const resolved = derive([commandRow]);

    expect(resolved.defaultProfile.name).toBe('default');
    expect(resolved.profiles).toHaveLength(1);
  });

  it('keeps the static profile when the seat model is not auto:cheapest', () => {
    const resolved = derive([proRow], createDefaultConfig());

    expect(resolved.defaultProfile.name).toBe('default');
    expect(resolved.profiles).toHaveLength(1);
  });

  it('keeps the static profile when no candidate is offered at all', () => {
    const resolved = derive([]);

    expect(resolved.defaultProfile.name).toBe('default');
    expect(resolved.profiles).toHaveLength(1);
  });

  it('excludes candidates priced on only one side', () => {
    const inputOnlyRow: AutoRouteCandidateRow = {
      config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro' },
      pricingInput: 0.25,
    };

    const resolved = derive([inputOnlyRow, commandRow]);

    expect(resolved.defaultProfile.name).toBe('default');
  });

  it('dedupes colliding derived names with a numeric suffix', () => {
    const duplicateRow: AutoRouteCandidateRow = {
      config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro' },
      pricingInput: 0.5,
      pricingOutput: 2.0,
    };

    const routed = withAutoRouteProfiles(autoCheapestConfig, [duplicateRow, proRow]);

    expect(Object.keys(routed.implementerProfiles?.profiles ?? {})).toEqual([
      'auto-kilo-code-kilo-kilo-auto-pro',
      'auto-kilo-code-kilo-kilo-auto-pro-2',
    ]);
  });

  it('prices every ranking with the one blended formula', () => {
    expect(blendedPricePer1M(0.25, 1)).toBe(4.25);

    const routed = withAutoRouteProfiles(autoCheapestConfig, [proRow]);

    expect(routed.implementerProfiles?.profiles['auto-kilo-code-kilo-kilo-auto-pro']).toMatchObject(
      { pricePer1M: blendedPricePer1M(0.25, 1) },
    );
  });
});

describe('withoutImplementerProfiles', () => {
  const table = {
    default: 'auto-a',
    profiles: {
      'auto-a': { kind: 'cli', tool: 'kilo-code', model: 'a', pricePer1M: 1 },
      'auto-b': { kind: 'cli', tool: 'kilo-code', model: 'b', pricePer1M: 2 },
    },
  } satisfies NonNullable<Config['implementerProfiles']>;

  it('drops the named row and re-points the default at the cheapest survivor', () => {
    const reduced = withoutImplementerProfiles(configWithProfiles(table), new Set(['auto-a']));

    expect(Object.keys(reduced.implementerProfiles?.profiles ?? {})).toEqual(['auto-b']);
    expect(reduced.implementerProfiles?.default).toBe('auto-b');
  });

  it('keeps a surviving default and leaves the table alone when nothing is dropped', () => {
    const config = configWithProfiles(table);

    const kept = withoutImplementerProfiles(config, new Set(['auto-b']));
    expect(kept.implementerProfiles?.default).toBe('auto-a');
    expect(withoutImplementerProfiles(config, new Set())).toBe(config);
    expect(withoutImplementerProfiles(config, new Set(['auto-a', 'auto-b']))).toBe(config);
    expect(withoutImplementerProfiles(createDefaultConfig(), new Set(['auto-a']))).toEqual(
      createDefaultConfig(),
    );
  });
});

describe('withAutoRouteProfiles', () => {
  const proRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/pro', contextLength: 200000 },
    pricingInput: 0.25,
    pricingOutput: 1,
  };
  const maxRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/max', contextLength: 400000 },
    pricingInput: 2,
    pricingOutput: 10,
  };
  const commandRow: AutoRouteCandidateRow = {
    config: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
  };
  const autoCheapestConfig: Config = {
    ...createDefaultConfig(),
    implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
  };

  it('writes the derived rows into the profile table the whole run reads', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [maxRow, commandRow, proRow]);

    const profiles = routed.implementerProfiles;
    expect(Object.keys(profiles?.profiles ?? {})).toEqual([
      'auto-kilo-code-kilo-kilo-auto-pro',
      'auto-kilo-code-kilo-kilo-auto-max',
    ]);
    expect(profiles?.default).toBe('auto-kilo-code-kilo-kilo-auto-pro');
    expect(profiles?.profiles['auto-kilo-code-kilo-kilo-auto-pro']).toMatchObject({
      kind: 'cli',
      tool: 'kilo-code',
      model: 'kilo/kilo-auto/pro',
      contextLength: 200000,
      pricePer1M: 4.25,
    });
  });

  it('keeps the auto:cheapest marker on the seat so identities still spell the policy', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [proRow, maxRow]);

    expect(routed.implementer.model).toBe('auto:cheapest');
  });

  it('carries the blended price through resolution so the router ranks by price', () => {
    const routed = withAutoRouteProfiles(autoCheapestConfig, [maxRow, proRow]);

    const resolved = resolveImplementerProfiles(routed);

    const priced = resolved.profiles.map((profile) => [profile.config.model, profile.pricePer1M]);

    expect(resolved.defaultProfile.config.model).toBe('kilo/kilo-auto/pro');
    expect(resolved.defaultProfile.pricePer1M).toBe(4.25);
    expect(priced).toEqual([
      ['kilo/kilo-auto/max', 42],
      ['kilo/kilo-auto/pro', 4.25],
    ]);
  });

  it('leaves a config that declares its own profiles untouched', () => {
    const config = configWithProfiles({
      profiles: {
        'agent-cli': { kind: 'cli', tool: 'codex', model: 'gpt-5-mini', contextLength: 200000 },
      },
    });

    expect(withAutoRouteProfiles(config, [proRow])).toBe(config);
  });

  it('leaves the config untouched when no candidate carries a price', () => {
    expect(withAutoRouteProfiles(autoCheapestConfig, [commandRow])).toBe(autoCheapestConfig);
    expect(withAutoRouteProfiles(autoCheapestConfig, [])).toBe(autoCheapestConfig);
  });

  it('leaves the config untouched when the seat carries no auto:cheapest marker', () => {
    const config = createDefaultConfig();

    expect(withAutoRouteProfiles(config, [proRow])).toBe(config);
  });
});
