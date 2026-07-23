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

    expect(
      securityWarnings(config).filter((w) => w.includes('found in') && w.includes('config')),
    ).toEqual([]);
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

  it('does not warn about key formats for providers without format hints', () => {
    const config: Config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'llama3',
        apiKey: 'any-key',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    expect(
      securityWarnings(config).filter((w) => w.includes("doesn't match expected format")),
    ).toEqual([]);
  });
});
