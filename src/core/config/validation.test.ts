import { describe, it, expect } from 'vitest';
import { validateConfig } from './validation.js';

const validConfig = {
  planner: { tool: 'claude-code' },
  implementer: { tool: 'ollama', model: 'qwen2.5-coder:7b', contextLength: 8192 },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
};

describe('validateConfig', () => {
  it('returns no errors for a valid config', () => {
    expect(validateConfig(validConfig)).toEqual([]);
  });

  it('rejects an invalid planner.tool', () => {
    const config = { ...validConfig, planner: { tool: 'unknown-tool' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('planner.tool');
    expect(errors[0]?.message).toContain('unknown-tool');
  });

  it.each([
    { tool: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { tool: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
    { tool: 'agent-sdk', envKey: 'ANTHROPIC_API_KEY' },
  ])('rejects $tool planner without $envKey and no planner.apiKey', ({ tool, envKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, planner: { tool } };
      const errors = validateConfig(config);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe('planner.apiKey');
      expect(errors[0]?.message).toContain(envKey);
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it.each([
    { tool: 'anthropic', envKey: 'ANTHROPIC_API_KEY', apiKey: 'my-key' },
    { tool: 'openrouter', envKey: 'OPENROUTER_API_KEY', apiKey: 'or-key' },
  ])('accepts $tool planner with planner.apiKey instead of env var', ({ tool, envKey, apiKey }) => {
    const orig = process.env[envKey];
    delete process.env[envKey];
    try {
      const config = { ...validConfig, planner: { tool, apiKey } };
      expect(validateConfig(config)).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env[envKey];
      else process.env[envKey] = orig;
    }
  });

  it('accepts anthropic planner with ANTHROPIC_API_KEY env var', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      const config = { ...validConfig, planner: { tool: 'anthropic' } };
      expect(validateConfig(config)).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('returns errors for multiple invalid fields at once', () => {
    const config = {
      planner: { tool: 'claude-code' },
      implementer: { tool: 'ollama', model: '', contextLength: -1 },
      validation: {},
      workflow: {},
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
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('implementer.apiBase');
    expect(errors[0]?.message).toContain('custom-ollama');
  });

  it('rejects non-number temperature', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 'hot' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('implementer.temperature');
  });

  it('rejects temperature out of range', () => {
    const config = { ...validConfig, implementer: { ...validConfig.implementer, temperature: 3 } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('implementer.temperature');
  });

  it('rejects negative maxRetries', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, maxRetries: -1 } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('workflow.maxRetries');
  });

  it('rejects non-boolean validation fields', () => {
    const config = { ...validConfig, validation: { ...validConfig.validation, typecheck: 'yes' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('validation.typecheck');
  });

  it('rejects invalid commitStrategy value', () => {
    const config = { ...validConfig, workflow: { ...validConfig.workflow, commitStrategy: 'invalid' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('workflow.commitStrategy');
  });

  it('accepts planner.tool = codex', () => {
    const config = { ...validConfig, planner: { tool: 'codex' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts shell planner with command', () => {
    const config = { ...validConfig, planner: { tool: 'shell', command: 'claude-zai' } };
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects shell planner without command', () => {
    const config = { ...validConfig, planner: { tool: 'shell' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('planner.command');
  });

  it('rejects shell planner with invalid outputFormat', () => {
    const config = { ...validConfig, planner: { tool: 'shell', command: 'my-tool', outputFormat: 'xml' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('planner.outputFormat');
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

  it('accepts config with no implementer.kind (backward compat)', () => {
    const config = { ...validConfig };
    expect((config as any).implementer.kind).toBeUndefined();
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
