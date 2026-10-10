import { describe, expect, it } from 'vitest';
import {
  readImplementerProfileConfig,
  resolveImplementerProfiles,
} from './implementer-profiles.js';
import { createDefaultConfig } from '../load/defaults.js';
import type { Config } from '../../schemas/config.js';

function configWithProfiles(profiles: NonNullable<Config['implementerProfiles']>): Config {
  return {
    ...createDefaultConfig(),
    implementerProfiles: profiles,
  };
}

describe('readImplementerProfileConfig', () => {
  it('uses the single implementer when the halt names a former profile', () => {
    const config = createDefaultConfig();
    expect(readImplementerProfileConfig(config, 'former-profile')).toBe(config.implementer);
  });

  it('reads the default or named block with its metadata and fallback', () => {
    const config = configWithProfiles({
      default: 'big',
      profiles: {
        small: { kind: 'cli', tool: 'claude-code', label: 'Small' },
        big: { kind: 'cli', tool: 'codex', label: 'Big', fallback: { tool: 'opencode' } },
      },
    });
    expect(readImplementerProfileConfig(config, undefined)).toEqual({
      kind: 'cli',
      tool: 'codex',
      label: 'Big',
      fallback: { tool: 'opencode' },
    });
    expect(readImplementerProfileConfig(config, 'small')).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      label: 'Small',
    });
    expect(readImplementerProfileConfig(config, 'missing')).toBeUndefined();
    expect(readImplementerProfileConfig(config, 'toString')).toBeUndefined();
  });
});

describe('resolveImplementerProfiles', () => {
  it('returns a stable default profile for single implementer configs', () => {
    const config = createDefaultConfig();

    const resolved = resolveImplementerProfiles(config);

    expect(resolved.defaultProfile).toMatchObject({
      name: 'default',
      label: 'Default implementer',
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
        },
        'local-qwen': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
          contextLength: 32768,
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
