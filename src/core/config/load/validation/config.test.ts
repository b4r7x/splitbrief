import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from './config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'OLLAMA_API_KEY',
    'OPENAI_API_KEY',
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

describe('validateConfig', () => {
  it.each([
    { role: 'planner', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', path: 'planner.apiKey' },
    {
      role: 'planner',
      provider: 'openrouter',
      envKey: 'OPENROUTER_API_KEY',
      path: 'planner.apiKey',
    },
    {
      role: 'implementer',
      provider: 'anthropic',
      envKey: 'ANTHROPIC_API_KEY',
      path: 'implementer.apiKey',
    },
    {
      role: 'implementer',
      provider: 'openrouter',
      envKey: 'OPENROUTER_API_KEY',
      path: 'implementer.apiKey',
    },
  ])('requires credentials for $provider $role unless config or env provides them', ({
    role,
    provider,
    envKey,
    path,
  }) => {
    const config =
      role === 'planner'
        ? makeConfig({
            planner: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' },
          })
        : makeConfig({
            implementer: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' },
          });

    expect(validateConfig(config).errors.find((e) => e.path === path)).toBeTruthy();

    const withConfigKey =
      role === 'planner'
        ? makeConfig({
            planner: {
              kind: 'api',
              provider,
              model: 'm',
              apiKey: 'configured-key',
              apiBase: 'https://api.example.com',
            },
          })
        : makeConfig({
            implementer: {
              kind: 'api',
              provider,
              model: 'm',
              apiKey: 'configured-key',
              apiBase: 'https://api.example.com',
            },
          });
    expect(validateConfig(withConfigKey).errors.find((e) => e.path === path)).toBeUndefined();

    process.env[envKey] = 'env-key';
    expect(validateConfig(config).errors.find((e) => e.path === path)?.message).toMatch(
      /exfiltration risk/,
    );
  });

  it.each([
    { role: 'planner', path: 'planner.apiKey' },
    { role: 'implementer', path: 'implementer.apiKey' },
  ])('requires credentials for agent-sdk $role unless config or env provides them', ({
    role,
    path,
  }) => {
    const config =
      role === 'planner'
        ? makeConfig({ planner: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' } })
        : {
            ...makeConfig(),
            implementer: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' },
          };

    expect(validateConfig(config).errors.find((e) => e.path === path)).toBeTruthy();

    const withConfigKey =
      role === 'planner'
        ? makeConfig({
            planner: {
              kind: 'agent-sdk',
              model: 'claude-3-5-sonnet-20241022',
              apiKey: 'sk-ant-key',
            },
          })
        : {
            ...makeConfig(),
            implementer: {
              kind: 'agent-sdk',
              model: 'claude-3-5-sonnet-20241022',
              apiKey: 'sk-ant-key',
            },
          };
    expect(validateConfig(withConfigKey).errors.find((e) => e.path === path)).toBeUndefined();

    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
    expect(validateConfig(config).errors.find((e) => e.path === path)).toBeUndefined();
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

  it('blocks the selected implementer profile when required credentials are missing', () => {
    const config = makeConfig({
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

  it('blocks non-default implementer profiles when required credentials are missing', () => {
    const config = makeConfig({
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

  it('requires credentials for an enabled remote intermediate provider', () => {
    const config = makeConfig({
      escalation: {
        intermediateProvider: 'openrouter',
        intermediateModel: 'openrouter/model',
        enabled: true,
      },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'escalation.intermediateProvider',
      message: 'OpenRouter intermediate provider requires OPENROUTER_API_KEY env var',
    });

    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    expect(
      validateConfig(config).errors.find((e) => e.path === 'escalation.intermediateProvider'),
    ).toBeUndefined();
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
        intermediateProvider: 'openrouter',
        intermediateModel: 'openrouter/model',
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
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        model: 'gpt-5.1',
        apiBase: 'https://api.openai.com/',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });

    expect(validateConfig(config).errors.find((e) => e.path === 'planner.apiKey')).toBeUndefined();
  });

  it('rejects planner apiBase URLs with embedded credentials without leaking them in errors', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
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

  it('keeps sessions.scope open for forward compatibility', () => {
    const { errors, data } = validateConfig(makeConfig({ sessions: { scope: 'global' } }));

    expect(errors).toEqual([]);
    expect(data?.sessions?.scope).toBe('global');
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

  it('warns when agent args contain {prompt}', () => {
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: './agent',
        args: ['--prompt', '{prompt}'],
        model: 'agent-default',
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(errors).toEqual([]);
    expect(warnings).toContainEqual(expect.stringContaining('implementer.args contains {prompt}'));
  });

  it('uses a stronger warning when bash -c args contain {prompt}', () => {
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', 'printf "%s" "{prompt}"'],
        model: 'agent-default',
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(errors).toEqual([]);
    expect(warnings).toContainEqual(
      expect.stringContaining('implementer.args passes {prompt} through bash -c'),
    );
    expect(warnings).toContainEqual(expect.stringContaining('shell-evaluate prompt text'));
  });

  it.each([
    ['bash with options before -c', 'bash', ['--noprofile', '-c', 'printf "%s" "{prompt}"']],
    ['bash combined flags', 'bash', ['-lc', 'printf "%s" "{prompt}"']],
    ['sh combined flags', 'sh', ['-ec', 'printf "%s" "{prompt}"']],
  ])('uses a stronger warning for %s', (_name, command, args) => {
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command,
        args,
        model: 'agent-default',
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(errors).toEqual([]);
    expect(warnings).toContainEqual(
      expect.stringContaining(`implementer.args passes {prompt} through ${command} -c`),
    );
    expect(warnings).toContainEqual(expect.stringContaining('shell-evaluate prompt text'));
  });
});
