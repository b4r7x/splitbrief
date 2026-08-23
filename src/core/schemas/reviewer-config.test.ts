import { describe, expect, it } from 'vitest';
import { ReviewerConfigSchema } from './reviewer-config.js';

describe('ReviewerConfigSchema', () => {
  it('accepts a CLI reviewer', () => {
    expect(
      ReviewerConfigSchema.safeParse({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.4',
      }).success,
    ).toBe(true);
  });

  it('rejects an API reviewer without a resolvable model', () => {
    const result = ReviewerConfigSchema.safeParse({
      kind: 'api',
      provider: 'my-gateway',
      service: 'my-gateway',
      offering: 'payg',
      apiBase: 'https://gateway.internal',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('model');
  });

  it('names the reviewer seat when an API provider is not admitted', () => {
    const result = ReviewerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'qwen3',
      apiBase: 'http://127.0.0.1:11434/v1',
    });

    expect(result.success).toBe(false);
    const provider = result.error?.issues.find((issue) => issue.path.join('.') === 'provider');
    expect(provider?.message).toContain('reviewer');
    expect(provider?.message).not.toContain('planner');
  });

  it('rejects effort support on a shell reviewer', () => {
    const result = ReviewerConfigSchema.safeParse({
      kind: 'shell',
      command: './review',
      model: 'local-reviewer',
      capabilities: { supportsEffort: true },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'capabilities.supportsEffort',
    );
  });
});
