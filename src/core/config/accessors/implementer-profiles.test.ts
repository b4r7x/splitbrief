import { describe, expect, it } from 'vitest';
import { resolveImplementerProfiles } from './implementer-profiles.js';
import { createDefaultConfig } from '../load/io.js';
import type { Config } from '../../schemas/config.js';

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
          provider: 'openrouter',
          service: 'openrouter',
          offering: 'payg',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-test',
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
