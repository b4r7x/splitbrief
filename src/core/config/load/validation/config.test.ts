import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from './config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['OLLAMA_API_KEY', 'OLLAMA_LOCAL_API_KEY', 'OPENAI_API_KEY']) {
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
  it('names a removed API provider at the config path that still uses it', () => {
    const config = {
      ...makeConfig(),
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'm',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    };

    expect(validateConfig(config).errors).toContainEqual({
      path: 'planner.provider',
      message: expect.stringContaining('API provider "openrouter" was removed'),
    });
  });

  it.each(['planner', 'reviewer', 'implementer'])(
    'names the removed agent-sdk runner kind in the %s block',
    (block) => {
      const config = {
        ...makeConfig(),
        [block]: { kind: 'agent-sdk', model: 'claude-sonnet-4-6' },
      };

      const { errors } = validateConfig(config);

      expect(errors).toContainEqual({
        path: `${block}.kind`,
        message: 'Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.',
      });
      expect(errors.filter((e) => e.path === `${block}.kind`)).toHaveLength(1);
    },
  );

  it('names the removed agent-sdk runner kind inside an implementer profile', () => {
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'sdk',
        profiles: { sdk: { kind: 'agent-sdk', model: 'claude-sonnet-4-6' } },
      },
    };

    expect(validateConfig(config).errors).toContainEqual({
      path: 'implementerProfiles.profiles.sdk.kind',
      message: 'Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.',
    });
  });

  it('allows local implementers without API credentials', () => {
    delete process.env.OLLAMA_API_KEY;
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'm',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('rejects local Ollama credentials outside its dedicated environment reference', () => {
    process.env.OLLAMA_API_KEY = 'cloud-key-canary';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';

    const localOllama = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'local-model',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
      },
    });

    expect(validateConfig(localOllama).errors).toEqual([]);
    for (const apiKey of ['inline-local-secret', 'env:ARBITRARY_LOCAL_KEY', 'env:OLLAMA_API_KEY']) {
      const rawConfig = {
        ...localOllama,
        implementer: { ...localOllama.implementer, apiKey },
      };
      expect(validateConfig(rawConfig).errors).toContainEqual(
        expect.objectContaining({
          path: 'implementer.apiKey',
          message: expect.stringContaining('OLLAMA_LOCAL_API_KEY'),
        }),
      );
    }
  });

  it('blocks the selected implementer profile when required credentials are missing', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'cheap-cloud',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'cheap-gateway',
            model: 'm',
            apiBase: 'https://cheap-gateway.example.test/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(
      errors.find((e) => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey'),
    ).toBeTruthy();
    expect(
      warnings.some((w) =>
        w.includes('Default implementer profile cheap-cloud is missing credentials'),
      ),
    ).toBe(false);
  });

  it('loads a config declaring the retired instant mode as quick and warns', () => {
    const base = makeConfig();
    const config = { ...base, workflow: { ...base.workflow, mode: 'instant' } };

    const { errors, warnings, data } = validateConfig(config);

    expect(errors).toEqual([]);
    expect(data?.workflow.mode).toBe('quick');
    expect(warnings.some((w) => w.includes('instant') && w.includes('quick'))).toBe(true);
  });

  it('blocks non-default implementer profiles when required credentials are missing', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'cheap-gateway',
            model: 'm',
            apiBase: 'https://cheap-gateway.example.test/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(
      errors.find((e) => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey'),
    ).toBeTruthy();
    expect(
      warnings.some((w) =>
        w.includes('Non-default implementer profile cheap-cloud is missing credentials'),
      ),
    ).toBe(false);
  });

  it('does not require credentials for local or disabled intermediate providers', () => {
    const local = makeConfig({
      escalation: {
        intermediateProvider: 'ollama',
        intermediateModel: 'qwen2.5-coder:7b',
        enabled: true,
      },
    });
    const disabled = makeConfig({
      escalation: {
        intermediateProvider: 'cheap-gateway',
        intermediateModel: 'cheap-gateway/model',
        enabled: false,
      },
    });

    expect(
      validateConfig(local).errors.find((e) => e.path === 'escalation.intermediateProvider'),
    ).toBeUndefined();
    expect(
      validateConfig(disabled).errors.find((e) => e.path === 'escalation.intermediateProvider'),
    ).toBeUndefined();
  });

  it('requires explicit credentials for custom remote providers', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-ollama',
        model: 'some-model',
        apiBase: 'http://my-server:11434/v1',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toMatchObject({
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
    expect(
      validateConfig(withKey).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('rejects unknown planner provider env apiKey references with arbitrary apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-planner',
        model: 'm',
        apiBase: 'https://custom-planner.example.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'planner.apiKey',
      message: expect.stringMatching(
        /custom\/unknown provider.*env apiKey reference.*apiBase.*exfiltration risk/i,
      ),
    });
  });

  it('rejects unknown implementer profile env apiKey references with arbitrary apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      implementerProfiles: {
        default: 'custom-remote',
        profiles: {
          'custom-remote': {
            kind: 'api',
            provider: 'custom-implementer',
            model: 'm',
            apiBase: 'https://custom-implementer.example.com/v1',
            apiKey: 'env:OPENAI_API_KEY',
          },
        },
      },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'implementerProfiles.profiles.custom-remote.apiKey',
      message: expect.stringMatching(
        /custom\/unknown provider.*env apiKey reference.*apiBase.*exfiltration risk/i,
      ),
    });
  });

  it('allows known provider env apiKey references with official same-origin apiBase', () => {
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('keeps userinfo credentials out of the custom-endpoint exfiltration error', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-planner',
        model: 'm',
        apiBase: 'https://alice:secret@proxy.example.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });

    const message = validateConfig(config).errors.find((e) => e.path === 'planner.apiKey')?.message;

    expect(message).toMatch(/exfiltration risk/);
    expect(message).not.toContain('alice');
    expect(message).not.toContain('secret');
  });

  it('rejects planner apiBase URLs with embedded credentials without leaking them in errors', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiKey: 'configured-key',
        apiBase: 'https://alice:secret@example.com/v1',
      },
    });

    const { errors } = validateConfig(config);

    expect(errors).toEqual([
      {
        path: 'planner.apiBase',
        message: 'Invalid apiBase: must not include credentials',
        diagnosticState: 'endpoint-invalid',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('alice');
    expect(JSON.stringify(errors)).not.toContain('secret');
  });

  it('rejects reviewer apiBase URLs with embedded credentials without leaking them in errors', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiKey: 'configured-key',
        apiBase: 'https://alice:secret@example.com/v1',
      },
    });

    const { errors } = validateConfig(config);

    expect(errors).toEqual([
      {
        path: 'reviewer.apiBase',
        message: 'Invalid apiBase: must not include credentials',
        diagnosticState: 'endpoint-invalid',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('alice');
    expect(JSON.stringify(errors)).not.toContain('secret');
  });

  it('names the reviewer seat in its credential error instead of the planner', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiBase: 'https://api.example.com',
      },
    });

    const { errors } = validateConfig(config);

    const reviewerError = errors.find((error) => error.path === 'reviewer.apiKey');
    expect(reviewerError?.message).toContain('reviewer');
    expect(reviewerError?.message).not.toContain('planner');
  });

  it('reports nothing extra for a config without a reviewer block', () => {
    expect(validateConfig(makeConfig())).toEqual({
      errors: [],
      warnings: [],
      data: expect.anything(),
    });
  });

  it.each([
    { key: 'autoApproveSpec', value: true },
    { key: 'autoApprovePlan', value: true },
    { key: 'commitStrategy', value: 'per-task' },
  ])('reports the removed workflow.$key field at its own path', ({ key, value }) => {
    const config = makeConfig();

    const { errors, data } = validateConfig({
      ...config,
      workflow: { ...config.workflow, [key]: value },
    });

    expect(errors).toContainEqual({
      path: `workflow.${key}`,
      message: expect.stringContaining('Unknown config key'),
    });
    expect(data).toBeUndefined();
  });

  it('rejects the removed sessions.scope global value', () => {
    const { errors, data } = validateConfig({ ...makeConfig(), sessions: { scope: 'global' } });

    expect(errors.some(({ path }) => path === 'sessions.scope')).toBe(true);
    expect(data).toBeUndefined();
  });

  it('rejects {prompt} in command strings', () => {
    const result = validateConfig({
      ...makeConfig(),
      implementer: {
        kind: 'agent',
        command: './agent-{prompt}',
        model: 'agent-default',
      },
    });

    expect(result.errors).toContainEqual({
      path: 'implementer.command',
      message: expect.stringContaining('must not contain {prompt}'),
    });
  });
});
