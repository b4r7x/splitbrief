import { describe, it, expect } from 'vitest';
import { validateConfig } from './config-validation.js';

const validConfig = {
  planner: { tool: 'claude-code' },
  implementer: { provider: 'ollama', model: 'qwen2.5-coder:7b', contextLength: 8192 },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitPerTask: true },
};

describe('validateConfig', () => {
  it('returns no errors for a valid config', () => {
    expect(validateConfig(validConfig)).toEqual([]);
  });

  it('rejects an invalid planner.tool', () => {
    const config = { ...validConfig, planner: { tool: 'unknown-tool' } };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('planner.tool');
    expect(errors[0].message).toContain('unknown-tool');
  });

  it('rejects anthropic planner without ANTHROPIC_API_KEY and no planner.apiKey', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, planner: { tool: 'anthropic' } };
      const errors = validateConfig(config);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('planner.apiKey');
      expect(errors[0].message).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
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

  it('accepts anthropic planner with planner.apiKey instead of env var', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, planner: { tool: 'anthropic', apiKey: 'my-key' } };
      expect(validateConfig(config)).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('rejects openrouter planner without OPENROUTER_API_KEY and no planner.apiKey', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = { ...validConfig, planner: { tool: 'openrouter' } };
      const errors = validateConfig(config);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('planner.apiKey');
      expect(errors[0].message).toContain('OPENROUTER_API_KEY');
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it('accepts openrouter planner with planner.apiKey instead of env var', () => {
    const orig = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const config = { ...validConfig, planner: { tool: 'openrouter', apiKey: 'or-key' } };
      expect(validateConfig(config)).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig;
    }
  });

  it('rejects agent-sdk planner without ANTHROPIC_API_KEY and no planner.apiKey', () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { ...validConfig, planner: { tool: 'agent-sdk' } };
      const errors = validateConfig(config);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('planner.apiKey');
      expect(errors[0].message).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('returns errors for multiple invalid fields at once', () => {
    const config = {
      planner: { tool: 'claude-code' },
      implementer: { provider: 'ollama', model: '', contextLength: -1 },
      validation: {},
      workflow: {},
    };
    const errors = validateConfig(config);
    const paths = errors.map(e => e.path);
    expect(paths).toContain('implementer.model');
    expect(paths).toContain('implementer.contextLength');
  });
});
