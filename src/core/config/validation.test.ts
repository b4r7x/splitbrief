import { describe, it, expect } from 'vitest';
import { validateConfig } from './validation.js';

const validConfig = {
  planner: { kind: 'cli', tool: 'claude-code' },
  implementer: { kind: 'api', tool: 'ollama', model: 'qwen2.5-coder:7b', apiBase: 'http://localhost:11434/v1', contextLength: 8192, temperature: 0.3 },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
};

describe('validateConfig', () => {
  it('returns no errors for a valid config', () => {
    expect(validateConfig(validConfig)).toEqual([]);
  });

  it('rejects an invalid planner.tool for cli kind', () => {
    const config = { ...validConfig, planner: { kind: 'cli', tool: 'unknown-tool' } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'planner.tool')).toBeTruthy();
  });

  it('rejects an invalid planner.kind', () => {
    const config = { ...validConfig, planner: { kind: 'bogus' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.kind')).toBeTruthy();
  });

  it.each([
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
  ])('rejects $provider api planner without $envKey and no planner.apiKey', ({ provider, envKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, planner: { kind: 'api', provider, model: 'm' } };
      const errors = validateConfig(config);
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
      const config = { ...validConfig, planner: { kind: 'agent-sdk' } };
      const errors = validateConfig(config);
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
      const config = { ...validConfig, planner: { kind: 'api', provider, model: 'm', apiKey } };
      expect(validateConfig(config)).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it('accepts anthropic api planner with ANTHROPIC_API_KEY env var', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      const config = { ...validConfig, planner: { kind: 'api', provider: 'anthropic', model: 'm' } };
      expect(validateConfig(config)).toEqual([]);
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
      workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
    };
    const errors = validateConfig(config);
    const paths = errors.map(e => e.path);
    expect(paths).toContain('implementer.model');
    expect(paths).toContain('implementer.contextLength');
  });

  it('accepts unknown provider when apiBase is set', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, tool: 'custom-ollama', apiBase: 'http://my-server:11434/v1' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects unknown provider without apiBase', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, tool: 'custom-ollama', apiBase: '' } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.apiBase')).toBeTruthy();
  });

  it('rejects non-number temperature', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 'hot' } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.temperature')).toBeTruthy();
  });

  it('rejects temperature out of range', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 3 } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'implementer.temperature')).toBeTruthy();
  });

  it('rejects negative maxRetries', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, maxRetries: -1 } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'workflow.maxRetries')).toBeTruthy();
  });

  it('rejects non-boolean validation fields', () => {
    const config = { ...validConfig, validation: { ...validConfig.validation, typecheck: 'yes' } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'validation.typecheck')).toBeTruthy();
  });

  it('rejects invalid commitStrategy value', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, commitStrategy: 'invalid' } };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.find(e => e.path === 'workflow.commitStrategy')).toBeTruthy();
  });

  it('accepts cli planner with tool = codex', () => {
    const config = { ...validConfig, planner: { kind: 'cli', tool: 'codex' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts shell planner with command', () => {
    const config = { ...validConfig, planner: { kind: 'shell', command: 'claude-zai' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects shell planner without command', () => {
    const config = { ...validConfig, planner: { kind: 'shell' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.command')).toBeTruthy();
  });

  it('rejects shell planner with invalid outputFormat', () => {
    const config = { ...validConfig, planner: { kind: 'shell', command: 'my-tool', outputFormat: 'xml' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'planner.outputFormat')).toBeTruthy();
  });

  it('accepts implementer.kind = api', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'api' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts implementer.kind = shell with command', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'shell', command: 'my-script' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects implementer.kind = shell without command', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'shell' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.command')).toBeTruthy();
  });

  it('rejects invalid implementer.kind', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'invalid' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.kind')).toBeTruthy();
  });

  it('accepts implementer.outputFormat = text', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, outputFormat: 'text' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects invalid implementer.outputFormat', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, outputFormat: 'invalid' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.outputFormat')).toBeTruthy();
  });

  it('accepts config with no implementer.kind (backward compat, defaults to api)', () => {
    const { kind: _, ...implementerNoKind } = validConfig.implementer;
    const config = { ...validConfig, implementer: implementerNoKind };
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts implementer.kind = agent with command', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'agent', command: 'claude-zai' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects implementer.kind = agent without command', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, kind: 'agent' } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.command')).toBeTruthy();
  });

  it('rejects timeout <= 0', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 0 } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.timeout')).toBeTruthy();
  });

  it('rejects timeout > 600000', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 700000 } };
    const errors = validateConfig(config);
    expect(errors.find(e => e.path === 'implementer.timeout')).toBeTruthy();
  });

  it('accepts valid timeout', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, timeout: 300000 } };
    expect(validateConfig(config)).toEqual([]);
  });
});
