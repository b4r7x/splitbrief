import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, createDefaultConfig } from '../src/config.js';

describe('validateConfig', () => {
  it('returns no errors for valid default config', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('accepts unknown provider when apiBase is set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'custom-ollama';
    (config as any).implementer.apiBase = 'http://my-server:11434/v1';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects unknown provider without apiBase', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'custom-ollama';
    (config as any).implementer.apiBase = '';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.apiBase');
    assert.ok(errors[0].message.includes('custom-ollama'));
  });

  it('rejects non-number temperature', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 'hot';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.temperature');
  });

  it('rejects temperature out of range', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 3;
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.temperature');
  });

  it('rejects negative maxRetries', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).workflow.maxRetries = -1;
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'workflow.maxRetries');
  });

  it('rejects non-boolean validation fields', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).validation.typecheck = 'yes';
    (config as any).workflow.commitPerTask = 1;
    const errors = validateConfig(config);
    assert.equal(errors.length, 2);
    const paths = errors.map((e) => e.path);
    assert.ok(paths.includes('validation.typecheck'));
    assert.ok(paths.includes('workflow.commitPerTask'));
  });

  it('collects multiple errors at once', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 5;
    (config as any).implementer.model = '';
    (config as any).workflow.maxRetries = -5;
    const errors = validateConfig(config);
    assert.equal(errors.length, 3);
  });

  it('accepts planner.tool = codex as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'codex';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects invalid planner tool', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'invalid-tool';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'planner.tool');
    assert.ok(errors[0].message.includes('invalid-tool'));
  });

  it('accepts planner.tool = shell with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    (config as any).planner.command = 'claude-zai';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects shell planner without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'planner.command');
  });

  it('rejects shell planner with invalid outputFormat', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    (config as any).planner.command = 'my-tool';
    (config as any).planner.outputFormat = 'xml';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'planner.outputFormat');
  });

  it('accepts implementer.type = api as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'api';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('accepts implementer.type = shell with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'shell';
    (config as any).implementer.command = 'my-script';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects implementer.type = shell without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'shell';
    const errors = validateConfig(config);
    const cmdError = errors.find((e) => e.path === 'implementer.command');
    assert.ok(cmdError, 'should produce an error for missing command');
    assert.ok(cmdError.message.includes('Shell implementer'));
  });

  it('rejects invalid implementer.type', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'invalid';
    const errors = validateConfig(config);
    const typeError = errors.find((e) => e.path === 'implementer.type');
    assert.ok(typeError, 'should produce an error for invalid type');
    assert.ok(typeError.message.includes('invalid'));
  });

  it('accepts implementer.outputFormat = text as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.outputFormat = 'text';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects invalid implementer.outputFormat', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.outputFormat = 'invalid';
    const errors = validateConfig(config);
    const fmtError = errors.find((e) => e.path === 'implementer.outputFormat');
    assert.ok(fmtError, 'should produce an error for invalid outputFormat');
    assert.ok(fmtError.message.includes('invalid'));
  });

  it('accepts config with no implementer.type (backward compat)', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    // type is not set by default - should be valid
    assert.equal((config as any).implementer.type, undefined);
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('accepts implementer.type = agent with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'agent';
    (config as any).implementer.command = 'claude-zai';
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects implementer.type = agent without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'agent';
    const errors = validateConfig(config);
    const cmdError = errors.find((e) => e.path === 'implementer.command');
    assert.ok(cmdError, 'should produce an error for missing command');
    assert.ok(cmdError.message.includes('Agent implementer'));
  });

  it('rejects timeout <= 0', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 0;
    const errors = validateConfig(config);
    const timeoutError = errors.find((e) => e.path === 'implementer.timeout');
    assert.ok(timeoutError, 'should produce an error for zero timeout');
  });

  it('rejects timeout > 600000', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 700000;
    const errors = validateConfig(config);
    const timeoutError = errors.find((e) => e.path === 'implementer.timeout');
    assert.ok(timeoutError, 'should produce an error for timeout exceeding max');
  });

  it('accepts valid timeout', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 300000;
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('requires apiKey for agent-sdk when ANTHROPIC_API_KEY is not set', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = createDefaultConfig() as unknown as Record<string, unknown>;
      (config as any).planner.tool = 'agent-sdk';
      const errors = validateConfig(config);
      const apiKeyError = errors.find((e) => e.path === 'planner.apiKey');
      assert.ok(apiKeyError, 'should produce an error for missing apiKey');
      assert.ok(apiKeyError.message.includes('Agent SDK'));
    } finally {
      if (original !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = original;
      }
    }
  });
});
