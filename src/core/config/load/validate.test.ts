import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../schemas/config.js';
import { validateConfig, securityWarnings } from './validate.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'OLLAMA_API_KEY']) {
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

describe('validateConfig', () => {
  it.each([
    { role: 'planner', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', path: 'planner.apiKey' },
    { role: 'planner', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', path: 'planner.apiKey' },
    { role: 'implementer', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', path: 'implementer.apiKey' },
    { role: 'implementer', provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', path: 'implementer.apiKey' },
  ])('requires credentials for $provider $role unless config or env provides them', ({ role, provider, envKey, path }) => {
    const config = role === 'planner'
      ? makeConfig({ planner: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' } })
      : makeConfig({ implementer: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' } });

    expect(validateConfig(config).errors.find(e => e.path === path)).toBeTruthy();

    const withConfigKey = role === 'planner'
      ? makeConfig({ planner: { kind: 'api', provider, model: 'm', apiKey: 'configured-key', apiBase: 'https://api.example.com' } })
      : makeConfig({ implementer: { kind: 'api', provider, model: 'm', apiKey: 'configured-key', apiBase: 'https://api.example.com' } });
    expect(validateConfig(withConfigKey).errors.find(e => e.path === path)).toBeUndefined();

    process.env[envKey] = 'env-key';
    expect(validateConfig(config).errors.find(e => e.path === path)).toBeUndefined();
  });

  it.each([
    { role: 'planner', path: 'planner.apiKey' },
    { role: 'implementer', path: 'implementer.apiKey' },
  ])('requires credentials for agent-sdk $role unless config or env provides them', ({ role, path }) => {
    const config = role === 'planner'
      ? makeConfig({ planner: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' } })
      : { ...makeConfig(), implementer: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' } };

    expect(validateConfig(config).errors.find(e => e.path === path)).toBeTruthy();

    const withConfigKey = role === 'planner'
      ? makeConfig({ planner: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022', apiKey: 'sk-ant-key' } })
      : { ...makeConfig(), implementer: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022', apiKey: 'sk-ant-key' } };
    expect(validateConfig(withConfigKey).errors.find(e => e.path === path)).toBeUndefined();

    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
    expect(validateConfig(config).errors.find(e => e.path === path)).toBeUndefined();
  });

  it('allows local implementers without API credentials', () => {
    delete process.env.OLLAMA_API_KEY;
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'm', apiBase: 'http://localhost:11434/v1' },
    });

    expect(validateConfig(config).errors.find(e => e.path === 'implementer.apiKey')).toBeUndefined();
  });

  it('blocks the selected implementer profile when required credentials are missing', () => {
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'cheap-cloud',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'openrouter',
            model: 'm',
            apiBase: 'https://openrouter.ai/api/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    };

    const { errors, warnings } = validateConfig(config);

    expect(errors.find(e => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey')).toBeTruthy();
    expect(warnings.some(w => w.includes('Default implementer profile cheap-cloud is missing credentials'))).toBe(false);
  });

  it('warns instead of blocking when an unused implementer profile is missing credentials', () => {
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'openrouter',
            model: 'm',
            apiBase: 'https://openrouter.ai/api/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    };

    const { errors, warnings } = validateConfig(config);

    expect(errors.find(e => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey')).toBeUndefined();
    expect(warnings.some(w => w.includes('Unused implementer profile cheap-cloud is missing credentials'))).toBe(true);
  });

  it('requires explicit credentials for custom remote providers', () => {
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'custom-ollama', model: 'some-model', apiBase: 'http://my-server:11434/v1' },
    });

    expect(validateConfig(config).errors.find(e => e.path === 'implementer.apiKey')).toMatchObject({
      message: 'Custom provider custom-ollama implementer requires implementer.apiKey',
    });

    const withKey = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-ollama',
        model: 'some-model',
        apiBase: 'http://my-server:11434/v1',
        apiKey: 'custom-key',
      },
    });
    expect(validateConfig(withKey).errors.find(e => e.path === 'implementer.apiKey')).toBeUndefined();
  });
});

describe('securityWarnings', () => {
  it('warns when API keys are stored in config instead of provider env vars', () => {
    const config: Config = makeConfig({
      planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-test', apiBase: 'https://api.anthropic.com' },
      implementer: { kind: 'api', provider: 'deepseek', model: 'deepseek-coder', apiKey: 'sk-test', apiBase: 'https://api.deepseek.com' },
    });

    const warnings = securityWarnings(config);

    expect(warnings.some(w => w.includes('ANTHROPIC_API_KEY') && w.includes('planner'))).toBe(true);
    expect(warnings.some(w => w.includes('DEEPSEEK_API_KEY') && w.includes('implementer'))).toBe(true);
  });

  it('does not warn when API keys only come from env vars', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
    const config: Config = makeConfig({
      planner: { kind: 'api', provider: 'anthropic', model: 'm', apiBase: 'https://api.anthropic.com' },
    });

    expect(securityWarnings(config).filter(w => w.includes('found in') && w.includes('config'))).toEqual([]);
  });

  it('does not recommend env keys for known providers using custom apiBase', () => {
    const config: Config = makeConfig({
      planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-test', apiBase: 'https://proxy.example.com/v1' },
    });

    expect(securityWarnings(config).some(w => w.includes('ANTHROPIC_API_KEY') && w.includes('planner config'))).toBe(false);
  });

  it('warns when provider key formats look wrong in config or env vars', () => {
    process.env['OPENROUTER_API_KEY'] = 'wrong-env-format';
    const config: Config = makeConfig({
      planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'wrong-config-format', apiBase: 'https://api.anthropic.com' },
      implementer: { kind: 'api', provider: 'openrouter', model: 'openrouter-model', apiBase: 'https://openrouter.ai/api/v1' },
    });

    const warnings = securityWarnings(config);

    expect(warnings.some(w => w.includes("doesn't match expected format (sk-ant-...)"))).toBe(true);
    expect(warnings.some(w => w.includes("doesn't match expected format (sk-or-...)"))).toBe(true);
  });

  it('does not warn about key formats for providers without format hints', () => {
    const config: Config = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'llama3', apiKey: 'any-key', apiBase: 'http://localhost:11434/v1' },
    });

    expect(securityWarnings(config).filter(w => w.includes("doesn't match expected format"))).toEqual([]);
  });
});
