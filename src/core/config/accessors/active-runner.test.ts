import { describe, expect, it } from 'vitest';
import { readActiveRunner, updateActiveRunner } from './active-runner.js';
import { createDefaultConfig } from '../load/io.js';
import type { Config } from '../../schemas/config.js';

function configWithProfiles(): Config {
  return {
    ...createDefaultConfig(),
    implementer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'stale-top-level-model',
    },
    implementerProfiles: {
      default: 'preferred',
      profiles: {
        preferred: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic',
          offering: 'payg',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'active-profile-model',
          label: 'Preferred API',
          costTier: 'frontier',
          capabilities: { writesFiles: 'extracted-code' },
        },
        dormant: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5-mini',
          label: 'Dormant profile',
          costTier: 'standard',
          capabilities: { writesFiles: 'direct' },
        },
      },
    },
  };
}

describe('active runner accessors', () => {
  it('reads the resolved default profile without changing the config', () => {
    const config = configWithProfiles();
    const original = structuredClone(config);

    const active = readActiveRunner({ config, role: 'implementer' });

    expect(active).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      model: 'active-profile-model',
    });
    expect(config).toEqual(original);
  });

  it('updates the resolved default profile while preserving its metadata and dormant profiles', () => {
    const config = configWithProfiles();
    const original = structuredClone(config);

    const updated = updateActiveRunner({
      config,
      role: 'implementer',
      updater: (existing) => ({ ...existing, model: 'updated-profile-model' }),
    });

    expect(readActiveRunner({ config: updated, role: 'implementer' })).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      model: 'updated-profile-model',
    });
    expect(updated.implementer).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      model: 'updated-profile-model',
    });
    expect(updated.implementerProfiles?.profiles.preferred).toMatchObject({
      label: 'Preferred API',
      costTier: 'frontier',
      capabilities: { writesFiles: 'extracted-code' },
      model: 'updated-profile-model',
    });
    expect(updated.implementerProfiles?.profiles.dormant).toEqual(
      config.implementerProfiles?.profiles.dormant,
    );
    expect(config).toEqual(original);
  });
});
