import { describe, expect, it } from 'vitest';
import { ImplementerConfigSchema, ImplementerProfilesConfigSchema } from './implementer-config.js';

describe('ImplementerConfigSchema', () => {
  it('requires implementers to declare a model', () => {
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

  it('rejects the planner-only capabilities field on shell and agent implementers', () => {
    const shell = ImplementerConfigSchema.safeParse({
      kind: 'shell',
      command: './run',
      model: 'local-shell',
      capabilities: { supportsSessionResume: true },
    });
    expect(shell.success).toBe(false);

    const agent = ImplementerConfigSchema.safeParse({
      kind: 'agent',
      command: 'my-agent',
      model: 'agent-default',
      capabilities: { supportsEffort: true },
    });
    expect(agent.success).toBe(false);
  });
});

describe('ImplementerProfilesConfigSchema', () => {
  it('rejects defaults that are not present in the profile map', () => {
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
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'default')).toBe(true);
    }
  });
});
