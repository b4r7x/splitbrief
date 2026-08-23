import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../schemas/config.js';
import { securityWarnings } from './warnings.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'OLLAMA_API_KEY',
    'OLLAMA_LOCAL_API_KEY',
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('securityWarnings', () => {
  it('warns when API keys are stored in config instead of provider env vars', () => {
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk-ant-test',
        apiBase: 'https://api.anthropic.com',
      },
      implementer: {
        kind: 'api',
        provider: 'deepseek',
        model: 'deepseek-coder',
        apiKey: 'sk-test',
        apiBase: 'https://api.deepseek.com',
      },
    });

    const warnings = securityWarnings(config);

    expect(warnings.some((w) => w.includes('ANTHROPIC_API_KEY') && w.includes('planner'))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes('DEEPSEEK_API_KEY') && w.includes('implementer'))).toBe(
      true,
    );
  });

  it('names the migration path in the inline-key warning', () => {
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk-ant-test',
        apiBase: 'https://api.anthropic.com',
      },
    });

    const warning = securityWarnings(config).find(
      (w) => w.includes('Inline API key') && w.includes('planner'),
    );

    expect(warning).toContain('export ANTHROPIC_API_KEY');
    expect(warning).toContain('remove the apiKey entry');
  });

  it('warns about an inline reviewer API key the way it warns about the planner', () => {
    const config: Config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk-ant-test',
        apiBase: 'https://api.anthropic.com',
      },
    });

    const warning = securityWarnings(config).find((w) => w.includes('Inline API key'));

    expect(warning).toContain('reviewer config');
    expect(warning).toContain('export ANTHROPIC_API_KEY');
    expect(warning).not.toContain('sk-ant-test');
  });

  it('leaves warnings unchanged when no reviewer block is configured', () => {
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk-ant-test',
        apiBase: 'https://api.anthropic.com',
      },
    });

    expect(securityWarnings(config).filter((w) => w.includes('Inline API key'))).toHaveLength(1);
  });

  it('does not warn when API keys only come from env vars', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiBase: 'https://api.anthropic.com',
      },
    });

    expect(securityWarnings(config).filter((w) => w.includes('Inline API key'))).toEqual([]);
  });

  it('does not recommend env keys for known providers using custom apiBase', () => {
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk-ant-test',
        apiBase: 'https://proxy.example.com/v1',
      },
    });

    expect(
      securityWarnings(config).some(
        (w) => w.includes('ANTHROPIC_API_KEY') && w.includes('planner config'),
      ),
    ).toBe(false);
  });

  it('warns when provider key formats look wrong in config or env vars', () => {
    process.env['OPENROUTER_API_KEY'] = 'wrong-env-format';
    const config: Config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'm',
        apiKey: 'wrong-config-format',
        apiBase: 'https://api.anthropic.com',
      },
      implementer: {
        kind: 'api',
        provider: 'openrouter',
        model: 'openrouter-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const warnings = securityWarnings(config);

    expect(warnings.some((w) => w.includes("doesn't match expected format (sk-ant-...)"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("doesn't match expected format (sk-or-...)"))).toBe(
      true,
    );
  });

  it('does not warn about a permitted local Ollama credential reference without a format hint', () => {
    process.env['OLLAMA_LOCAL_API_KEY'] = 'local-daemon-key';
    const config: Config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'llama3',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    expect(
      securityWarnings(config).filter((w) => w.includes("doesn't match expected format")),
    ).toEqual([]);
  });
});
