import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('admits the local API providers the catalog gives the planner tier', () => {
    for (const [provider, apiBase] of [
      ['ollama', 'http://127.0.0.1:11434/v1'],
      ['lm-studio', 'http://localhost:1234/v1'],
    ] as const) {
      const result = ReviewerConfigSchema.safeParse({
        kind: 'api',
        provider,
        service: provider,
        offering: 'local',
        model: 'qwen3',
        apiBase,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ provider, apiBase });
    }
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

// Every catalog provider is admitted in the planner tier, so the seat-named refusal only
// runs against an injected implementer-only descriptor.
describe('reviewer API admission against an implementer-only descriptor', () => {
  afterEach(() => {
    vi.doUnmock('../providers/api-provider-catalog.js');
    vi.resetModules();
  });

  it('names the reviewer seat when an API provider is not admitted', async () => {
    vi.resetModules();
    vi.doMock('../providers/api-provider-catalog.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/api-provider-catalog.js')>();
      return {
        ...actual,
        API_PROVIDER_CATALOG: {
          ...actual.API_PROVIDER_CATALOG,
          ollama: { ...actual.API_PROVIDER_CATALOG.ollama, roles: ['implementer'] },
        },
        PLANNER_API_PROVIDER_IDS: [],
        IMPLEMENTER_API_PROVIDER_IDS: ['ollama', 'lm-studio'],
      };
    });
    const { ReviewerConfigSchema: ScopedReviewerConfigSchema } = await import(
      './reviewer-config.js'
    );

    const result = ScopedReviewerConfigSchema.safeParse({
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
});
