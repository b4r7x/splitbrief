import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createDefaultConfig } from '../load/io.js';
import { resolveEffectiveConfig } from './effective-config.js';

describe('resolveEffectiveConfig', () => {
  it('returns validated config with effective warnings only', () => {
    const base = createDefaultConfig();
    const { config, warnings } = resolveEffectiveConfig({
      base,
      baseWarnings: ['base warning'],
    });

    expect(config.version).toBe(3);
    expect(warnings).not.toContain('base warning');
  });

  it('rejects invalid overrides after merge', () => {
    const base = createDefaultConfig();
    expect(() =>
      resolveEffectiveConfig({
        base,
        overrides: { budget: -1 },
      }),
    ).toThrow(/Must be a positive number/);
  });

  it('applies implementer model override before validation', () => {
    const base = createDefaultConfig();
    const { config } = resolveEffectiveConfig({
      base,
      overrides: { implementer: { model: 'deepseek-chat' } },
    });

    expect(config.implementer).toMatchObject({ model: 'deepseek-chat' });
  });

  it('drops stale inline-key warnings after provider overrides', () => {
    const base = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'sk-ant-inline',
      },
    });

    const { config, warnings } = resolveEffectiveConfig({
      base,
      overrides: {
        implementer: {
          tool: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
        },
      },
      baseWarnings: [
        'API key found in implementer config. For better security, set ANTHROPIC_API_KEY environment variable and remove apiKey from config.',
      ],
    });

    expect(config.implementer).toMatchObject({ kind: 'api', provider: 'ollama' });
    expect(warnings).toEqual([]);
  });
});
