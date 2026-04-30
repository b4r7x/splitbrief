import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateConfig, securityWarnings } from './validate.js';
import type { Config } from '../../schemas/config.js';
import type { ApiImplementerConfig } from '../../schemas/implementer-config.js';

const validConfig = {
  version: 2 as const,
  planner: { kind: 'cli', tool: 'claude-code', model: 'default' },
  implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b', apiBase: 'http://localhost:11434/v1', contextLength: 8192, temperature: 0.3 },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true },
};

const baseApiImplementer: ApiImplementerConfig = {
  kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b', apiBase: 'http://localhost:11434/v1', contextLength: 8192, temperature: 0.3,
};

const baseConfig: Config = {
  version: 2,
  planner: { kind: 'cli', tool: 'claude-code', model: 'default' },
  implementer: baseApiImplementer,
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true },
};

describe('validateConfig', () => {
  it('returns no errors for a valid config', () => {
    const result = validateConfig(validConfig);
    expect(result.errors).toEqual([]);
    expect(result.data).toBeDefined();
  });

  it('rejects an invalid planner.tool for cli kind', () => {
    const config = { ...validConfig, planner: { kind: 'cli', tool: 'unknown-tool' } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'planner.tool')).toBeTruthy();
  });

  it('rejects an invalid planner.kind', () => {
    const config = { ...validConfig, planner: { kind: 'bogus' } };
    const result = validateConfig(config);
    expect(result.errors.find(e => e.path === 'planner.kind')).toBeTruthy();
    expect(result.data).toBeUndefined();
  });

  it('produces all schema errors including implementer errors when validation fails', () => {
    const config = {
      ...validConfig,
      planner: { kind: 'bogus' },
      implementer: { ...validConfig.implementer, tool: 'custom', kind: 'api', apiBase: '' },
    };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.kind')).toBeTruthy();
    expect(errors.find(e => e.path === 'implementer.apiBase')).toBeTruthy();
  });

  it.each([
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
  ])('rejects $provider api planner without $envKey and no planner.apiKey', ({ provider, envKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, planner: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' } };
      const { errors } = validateConfig(config);
      expect(errors.find(e => e.path === 'planner.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it("rejects 'agent-sdk' planner without 'ANTHROPIC_API_KEY' and no planner.apiKey", () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, planner: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' } };
      const { errors } = validateConfig(config);
      expect(errors.find(e => e.path === 'planner.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it.each([
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', apiKey: 'my-key' },
    { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', apiKey: 'or-key' },
  ])('accepts $provider api planner with planner.apiKey instead of env var', ({ provider, envKey, apiKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, planner: { kind: 'api', provider, model: 'm', apiKey, apiBase: 'https://api.example.com' } };
      expect(validateConfig(config).errors).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it('accepts anthropic api planner with ANTHROPIC_API_KEY env var', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      const config = { ...validConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiBase: 'https://api.anthropic.com' } };
      expect(validateConfig(config).errors).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it.each([
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
  ])('rejects $provider api implementer without $envKey and no implementer.apiKey', ({ provider, envKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, implementer: { kind: 'api', provider, model: 'm', apiBase: 'https://api.example.com' } };
      const { errors } = validateConfig(config);
      expect(errors.find(e => e.path === 'implementer.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it('accepts ollama api implementer without API key (local provider)', () => {
    const config = { ...validConfig, implementer: { kind: 'api', provider: 'ollama', model: 'm', apiBase: 'http://localhost:11434/v1' } };
    expect(validateConfig(config).errors.filter(e => e.path === 'implementer.apiKey')).toEqual([]);
  });

  it('validates API key requirements for implementer profiles', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = {
        ...validConfig,
        implementerProfiles: {
          profiles: {
            'cheap-cloud': {
              kind: 'api',
              provider: 'openrouter',
              model: 'm',
              apiBase: 'https://openrouter.ai/api/v1',
            },
          },
        },
      };

      const { errors } = validateConfig(config);

      expect(errors.find(e => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it('treats unused implementer profile credentials as warnings instead of errors', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = {
        ...validConfig,
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
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it('blocks when the selected implementer profile is missing required credentials', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = {
        ...validConfig,
        implementerProfiles: {
          default: 'cheap-cloud',
          profiles: {
            'cheap-cloud': {
              kind: 'api',
              provider: 'openrouter',
              model: 'm',
              apiBase: 'https://openrouter.ai/api/v1',
            },
          },
        },
      };

      const { errors } = validateConfig(config);

      expect(errors.find(e => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it('allows a selected profile credential warning when another implementer profile can run', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = {
        ...validConfig,
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

      expect(errors.find(e => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey')).toBeUndefined();
      expect(warnings.some(w => w.includes('Default implementer profile cheap-cloud is missing credentials'))).toBe(true);
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it.each([
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', apiKey: 'sk-ant-key' },
    { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', apiKey: 'sk-or-key' },
  ])('accepts $provider api implementer with implementer.apiKey', ({ provider, envKey, apiKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, implementer: { kind: 'api', provider, model: 'm', apiKey, apiBase: 'https://api.example.com' } };
      expect(validateConfig(config).errors.filter(e => e.path === 'implementer.apiKey')).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it("rejects 'agent-sdk' implementer without 'ANTHROPIC_API_KEY' and no implementer.apiKey", () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, implementer: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022' } };
      const { errors } = validateConfig(config);
      expect(errors.find(e => e.path === 'implementer.apiKey')).toBeTruthy();
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it("accepts 'agent-sdk' implementer with implementer.apiKey", () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, implementer: { kind: 'agent-sdk', model: 'claude-3-5-sonnet-20241022', apiKey: 'sk-ant-key' } };
      expect(validateConfig(config).errors.filter(e => e.path === 'implementer.apiKey')).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('returns errors for multiple invalid fields at once', () => {
    const config = {
      planner: { tool: 'claude-code' },
      implementer: { kind: 'api', tool: 'ollama', model: '', apiBase: 'http://localhost:11434/v1', contextLength: -1, temperature: 0.3 },
      validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
      workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true },
    };
    const { errors } = validateConfig(config);
    const paths = errors.map(e => e.path);
    expect(paths).toContain('implementer.model');
    expect(paths).toContain('implementer.contextLength');
  });

  it('rejects unknown provider without explicit apiKey even when apiBase is set', () => {
    const config = { ...validConfig, implementer: { kind: 'api', provider: 'custom-ollama', model: 'some-model', apiBase: 'http://my-server:11434/v1' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.apiKey')).toMatchObject({
      message: 'Custom provider custom-ollama implementer requires implementer.apiKey',
    });
  });

  it('accepts unknown provider when apiBase and apiKey are set', () => {
    const config = { ...validConfig, implementer: { kind: 'api', provider: 'custom-ollama', model: 'some-model', apiBase: 'http://my-server:11434/v1', apiKey: 'custom-key' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('rejects unknown provider without apiBase', () => {
    const config = { ...validConfig, implementer: { kind: 'api', provider: 'custom-ollama', model: 'some-model', apiBase: '' } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.apiBase')).toBeTruthy();
  });

  it('rejects non-number temperature', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 'hot' } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.temperature')).toBeTruthy();
  });

  it('rejects temperature out of range', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 3 } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.temperature')).toBeTruthy();
  });

  it('rejects negative maxRetries', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, maxRetries: -1 } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'workflow.maxRetries')).toBeTruthy();
  });

  it('rejects non-boolean validation fields', () => {
    const config = { ...validConfig, validation: { ...validConfig.validation, typecheck: 'yes' } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'validation.typecheck')).toBeTruthy();
  });

  it('rejects invalid commitStrategy value', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, commitStrategy: 'invalid' } };
    const { errors } = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'workflow.commitStrategy')).toBeTruthy();
  });

  it('accepts cli planner with tool = codex', () => {
    const config = { ...validConfig, planner: { kind: 'cli', tool: 'codex' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('accepts shell planner with command', () => {
    const config = { ...validConfig, planner: { kind: 'shell', command: 'claude-zai' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('rejects shell planner without command', () => {
    const config = { ...validConfig, planner: { kind: 'shell' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.command')).toBeTruthy();
  });

  it('rejects shell planner with invalid outputFormat', () => {
    const config = { ...validConfig, planner: { kind: 'shell', command: 'my-tool', outputFormat: 'xml' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.outputFormat')).toBeTruthy();
  });

  it('accepts implementer.kind = api', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'api' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('accepts implementer.kind = shell with command', () => {
    const config = { ...validConfig, implementer: { kind: 'shell', command: 'my-script', model: 'default' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('rejects implementer.kind = shell without command', () => {
    const config = { ...validConfig, implementer: { kind: 'shell', model: 'default' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.command')).toBeTruthy();
  });

  it('rejects invalid implementer.kind', () => {
    const config = { ...validConfig, implementer: { kind: 'invalid', model: 'default' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.kind')).toBeTruthy();
  });

  it('accepts implementer.outputFormat = text for shell kind', () => {
    const config = { ...validConfig, implementer: { kind: 'shell', command: 'my-script', model: 'default', outputFormat: 'text' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('rejects invalid implementer.outputFormat', () => {
    const config = { ...validConfig, implementer: { kind: 'shell', command: 'my-script', model: 'default', outputFormat: 'invalid' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.outputFormat')).toBeTruthy();
  });

  it('requires implementer.kind (discriminated union requires explicit kind)', () => {
    const { kind: _, ...implementerNoKind } = validConfig.implementer;
    const config = { ...validConfig, implementer: implementerNoKind };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.kind')).toBeTruthy();
  });

  it('accepts implementer.kind = agent with command', () => {
    const config = { ...validConfig, implementer: { kind: 'agent', command: 'claude-zai', model: 'default' } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('rejects implementer.kind = agent without command', () => {
    const config = { ...validConfig, implementer: { kind: 'agent', model: 'default' } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.command')).toBeTruthy();
  });

  it('rejects timeout <= 0', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 0 } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.timeout')).toBeTruthy();
  });

  it('rejects timeout > 600000', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 700000 } };
    const { errors } = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.timeout')).toBeTruthy();
  });

  it('accepts valid timeout', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 300000 } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('includes security warnings in result', () => {
    const config = { ...validConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-test', apiBase: 'https://api.anthropic.com' } };
    const { warnings } = validateConfig(config);
    expect(warnings.some(w => w.includes('environment variable'))).toBe(true);
  });
});

describe('securityWarnings', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('warns when planner.apiKey is set in config', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-test', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes('set ANTHROPIC_API_KEY environment variable') && w.includes('planner'))).toBe(true);
  });

  it('warns when implementer.apiKey is set in config', () => {
    const config: Config = { ...baseConfig, implementer: { kind: 'api', provider: 'deepseek', model: 'deepseek-coder', apiKey: 'sk-test', apiBase: 'https://api.deepseek.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes('set DEEPSEEK_API_KEY environment variable') && w.includes('implementer'))).toBe(true);
  });

  it('no warning when keys only in env vars', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.filter(w => w.includes('found in') && w.includes('config'))).toEqual([]);
  });

  it('no warning when no keys configured at all', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'cli', tool: 'claude-code' } };
    expect(securityWarnings(config)).toEqual([]);
  });

  it('warns when Anthropic key does not start with sk-ant-', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'wrong-prefix', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes("doesn't match expected format (sk-ant-...)"))).toBe(true);
  });

  it('warns when OpenRouter key does not start with sk-or-', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'openrouter', model: 'm', apiKey: 'wrong-prefix', apiBase: 'https://openrouter.ai/api/v1' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes("doesn't match expected format (sk-or-...)"))).toBe(true);
  });

  it('no warning when key format matches', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-correct', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.filter(w => w.includes("doesn't match expected format"))).toEqual([]);
  });

  it('no warning for providers without format hints', () => {
    const config: Config = { ...baseConfig, implementer: { kind: 'api', provider: 'ollama', model: 'llama3', apiKey: 'any-key', apiBase: 'http://localhost:11434/v1' } };
    const warnings = securityWarnings(config);
    expect(warnings.filter(w => w.includes("doesn't match expected format"))).toEqual([]);
  });

  it('no warning when no key is provided', () => {
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.filter(w => w.includes("doesn't match expected format"))).toEqual([]);
  });

  it('checks key format from env var too', () => {
    process.env['ANTHROPIC_API_KEY'] = 'wrong-format-key';
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes("doesn't match expected format (sk-ant-...)"))).toBe(true);
  });

  it('warns when planner apiKey is in config AND env var is set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-value';
    const config: Config = { ...baseConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm', apiKey: 'sk-ant-config-value', apiBase: 'https://api.anthropic.com' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes('planner') && w.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('warns when implementer apiKey is in config AND env var is set', () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-env-value';
    const config: Config = { ...baseConfig, implementer: { kind: 'api', provider: 'openrouter', model: 'openrouter-model', apiKey: 'sk-or-config-value', apiBase: 'https://openrouter.ai/api/v1' } };
    const warnings = securityWarnings(config);
    expect(warnings.some(w => w.includes('implementer') && w.includes('OPENROUTER_API_KEY'))).toBe(true);
  });
});
