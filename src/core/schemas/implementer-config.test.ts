import { describe, expect, it } from 'vitest';
import {
  ImplementerConfigSchema,
  ImplementerProfileConfigSchema,
  ImplementerProfilesConfigSchema,
} from './implementer-config.js';

// `ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields)`.
// The generic discriminated-union behaviour (all 5 kinds parse minimally,
// unknown kinds rejected, strict() rejects extras, optional-model override
// works) is covered once in `runner-fields.test.ts`. The only implementer-
// specific delta over planner is that `model` is required (planner overrides
// it to optional in `planner-config.ts`).
describe('ImplementerConfigSchema', () => {
  it('requires model — that is the contract distinction from planner', () => {
    const withoutModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
    });
    expect(withoutModel.success).toBe(false);

    const withModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
    });
    expect(withModel.success).toBe(true);
  });
});

describe('ImplementerProfilesConfigSchema', () => {
  it('parses profile runner fields plus label and cost tier', () => {
    const result = ImplementerProfileConfigSchema.parse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      label: 'Local Qwen',
      costTier: 'local',
      capabilities: { writesFiles: 'extracted-code' },
    });

    expect(result.label).toBe('Local Qwen');
    expect(result.costTier).toBe('local');
    expect(result.capabilities?.writesFiles).toBe('extracted-code');
  });

  it('rejects profile metadata on the legacy single implementer shape', () => {
    const result = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      costTier: 'local',
    });

    expect(result.success).toBe(false);
  });

  it('rejects capability metadata that conflicts with the runner write mode', () => {
    const result = ImplementerProfileConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      capabilities: { writesFiles: 'direct' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.join('.') === 'capabilities.writesFiles')).toBe(true);
    }
  });

  it('rejects profile defaults that are not present in the profile map', () => {
    const result = ImplementerProfilesConfigSchema.safeParse({
      default: 'missing-profile',
      profiles: {
        'local-qwen': {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.join('.') === 'default')).toBe(true);
    }
  });
});
