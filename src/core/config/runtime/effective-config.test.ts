import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createDefaultConfig, formatConfigLoaderDiagnostic } from '../load/io.js';
import type { ConfigLoaderDiagnostic } from '../load/io.js';
import { formatEffectiveConfigWarnings, resolveEffectiveConfig } from './effective-config.js';

describe('resolveEffectiveConfig', () => {
  it('returns effective validation warnings as typed records', () => {
    const base = {
      ...createDefaultConfig(),
      implementer: {
        kind: 'api' as const,
        provider: 'anthropic' as const,
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'sk-ant-inline',
      },
    };
    const { config, warnings } = resolveEffectiveConfig({
      base,
    });

    expect(config.version).toBe(3);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        source: 'validation',
        message: expect.stringContaining('API key found in implementer config'),
      }),
    );
  });

  it('keeps stable loader warnings while discarding override-cleared validation warnings', () => {
    const base = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'sk-ant-inline',
      },
    });
    const permissionPath = '/tmp/project/.splitbrief/config.yaml';

    const { config, warnings } = resolveEffectiveConfig({
      base,
      overrides: {
        implementer: {
          tool: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
        },
      },
      loaderDiagnostics: [{ kind: 'config-file-permissions', path: permissionPath }],
    });

    expect(config.implementer).toMatchObject({ kind: 'api', provider: 'ollama' });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        source: 'loader',
        diagnostic: { kind: 'config-file-permissions', path: permissionPath },
      }),
    );
    expect(
      warnings.some(
        (warning) =>
          warning.source === 'validation' && warning.message.includes('ANTHROPIC_API_KEY'),
      ),
    ).toBe(false);
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
    });

    expect(config.implementer).toMatchObject({ kind: 'api', provider: 'ollama' });
    expect(warnings).toEqual([]);
  });

  it('deduplicates colliding messages only when formatting for output', () => {
    const diagnostic = {
      kind: 'config-migration',
      code: 'deprecated-v2',
    } satisfies ConfigLoaderDiagnostic;
    const message = formatConfigLoaderDiagnostic(diagnostic);

    expect(
      formatEffectiveConfigWarnings([
        { source: 'loader', diagnostic },
        { source: 'validation', message },
      ]),
    ).toEqual([message]);
  });
});
