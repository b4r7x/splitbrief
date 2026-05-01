import { describe, it, expect } from 'vitest';
import { ConfigSchema } from './config.js';
import { createDefaultConfig } from '../config/load/load.js';

const validConfig = createDefaultConfig();

describe('ConfigSchema palette extension', () => {
  it('parses config without palette field', () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.palette).toBeUndefined();
  });

  it('parses config with palette.customActions', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      palette: {
        customActions: [{ id: 'x', label: 'X', command: '/help' }],
      },
    });
    expect(result.palette?.customActions?.[0]?.command).toBe('/help');
  });

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
  it('parses minimal config without approval field', () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.approval).toBeUndefined();
  });

  it('parses approval: { enabled: true } with defaults', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { enabled: true } });
    expect(result.approval?.enabled).toBe(true);
    expect(result.approval?.feedRejectionsToPlanner).toBe(true);
  });

  it('preserves approval.enabled: false', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { enabled: false } });
    expect(result.approval?.enabled).toBe(false);
  });

  it('parses approval.tiers with write_out_of_scope confirm override', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      approval: { tiers: { write_out_of_scope: 'confirm' } },
    });
    expect(result.approval?.tiers?.write_out_of_scope).toBe('confirm');
  });

  it('preserves approval.headless: true', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { headless: true } });
    expect(result.approval?.headless).toBe(true);
  });

  it('preserves approval.feedRejectionsToPlanner: false', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      approval: { feedRejectionsToPlanner: false },
    });
    expect(result.approval?.feedRejectionsToPlanner).toBe(false);
  });

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
  it('parses old single implementer config without profiles', () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.implementerProfiles).toBeUndefined();
    expect(result.implementer).toEqual(validConfig.implementer);
  });

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

  it('allows profiles without an explicit default so the accessor can choose deterministically', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      implementerProfiles: {
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
        },
      },
    });

    expect(result.implementerProfiles?.default).toBeUndefined();
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

describe('ConfigSchema planner estimate review', () => {
  it('keeps plannerEstimateReview off in the default config', () => {
    expect(createDefaultConfig().plannerEstimateReview).toBe(false);
  });

  it('preserves plannerEstimateReview opt-in', () => {
    const result = ConfigSchema.parse({ ...validConfig, plannerEstimateReview: true });

    expect(result.plannerEstimateReview).toBe(true);
  });
});

describe('ConfigSchema auto split overflow', () => {
  it('keeps autoSplitOverflow off in the default config', () => {
    expect(createDefaultConfig().autoSplitOverflow).toBe(false);
  });

  it('preserves autoSplitOverflow opt-in', () => {
    const result = ConfigSchema.parse({ ...validConfig, autoSplitOverflow: true });

    expect(result.autoSplitOverflow).toBe(true);
  });
});
