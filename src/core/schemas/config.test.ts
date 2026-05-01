import { describe, it, expect } from 'vitest';
import { ConfigSchema } from './config.js';
import { createDefaultConfig } from '../config/load/load.js';

const validConfig = createDefaultConfig();

describe('ConfigSchema palette extension', () => {
  it('throws when id is empty string', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        palette: {
          customActions: [{ id: '', label: 'X', command: '/help' }],
        },
      })
    ).toThrow();
  });

  it('throws when command does not start with /', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        palette: {
          customActions: [{ id: 'x', label: 'X', command: 'no-slash' }],
        },
      })
    ).toThrow();
  });

});

describe('ConfigSchema approval extension', () => {
  it('throws on invalid tier string in tiers map', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        approval: { tiers: { read: 'invalid_tier' } },
      })
    ).toThrow();
  });
});

describe('ConfigSchema implementer profiles extension', () => {
  it('parses named implementer profiles with metadata', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
            contextLength: 32768,
            label: 'Local Qwen',
            costTier: 'local',
            capabilities: { writesFiles: 'extracted-code' },
          },
          'cheap-cloud': {
            kind: 'api',
            provider: 'openrouter',
            apiBase: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-or-test',
            model: 'qwen/qwen3-coder',
            contextLength: 131072,
            costTier: 'cheap',
          },
        },
      },
    });

    expect(result.implementerProfiles?.default).toBe('local-qwen');
    expect(result.implementerProfiles?.profiles['cheap-cloud']?.costTier).toBe('cheap');
    expect(result.implementerProfiles?.profiles['local-qwen']?.capabilities?.writesFiles).toBe('extracted-code');
  });

  it('rejects unknown default profile names', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        implementerProfiles: {
          default: 'missing-profile',
          profiles: {
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
            },
          },
        },
      })
    ).toThrow(/Default implementer profile/);
  });

  it('rejects invalid profile names', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        implementerProfiles: {
          profiles: {
            'Local Qwen': {
              kind: 'api',
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
            },
          },
        },
      })
    ).toThrow();
  });

  it('rejects empty profile maps', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        implementerProfiles: {
          profiles: {},
        },
      })
    ).toThrow(/Define at least one implementer profile/);
  });
});

