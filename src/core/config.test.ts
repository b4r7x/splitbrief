import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { createDefaultConfig, writeConfigSelection, loadConfig } from './config.js';
import { validateConfig } from './config-validation.js';

describe('validateConfig', () => {
  it('returns no errors for valid default config', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('accepts unknown provider when apiBase is set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'custom-ollama';
    (config as any).implementer.apiBase = 'http://my-server:11434/v1';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects unknown provider without apiBase', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'custom-ollama';
    (config as any).implementer.apiBase = '';
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('implementer.apiBase');
    expect(errors[0].message).toContain('custom-ollama');
  });

  it('rejects non-number temperature', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 'hot';
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('implementer.temperature');
  });

  it('rejects temperature out of range', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 3;
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('implementer.temperature');
  });

  it('rejects negative maxRetries', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).workflow.maxRetries = -1;
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('workflow.maxRetries');
  });

  it('rejects non-boolean validation fields', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).validation.typecheck = 'yes';
    (config as any).workflow.commitPerTask = 1;
    const errors = validateConfig(config);
    expect(errors.length).toBe(2);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain('validation.typecheck');
    expect(paths).toContain('workflow.commitPerTask');
  });

  it('collects multiple errors at once', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 5;
    (config as any).implementer.model = '';
    (config as any).workflow.maxRetries = -5;
    const errors = validateConfig(config);
    expect(errors.length).toBe(3);
  });

  it('accepts planner.tool = codex as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'codex';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects invalid planner tool', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'invalid-tool';
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('planner.tool');
    expect(errors[0].message).toContain('invalid-tool');
  });

  it('accepts planner.tool = shell with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    (config as any).planner.command = 'claude-zai';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects shell planner without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('planner.command');
  });

  it('rejects shell planner with invalid outputFormat', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).planner.tool = 'shell';
    (config as any).planner.command = 'my-tool';
    (config as any).planner.outputFormat = 'xml';
    const errors = validateConfig(config);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('planner.outputFormat');
  });

  it('accepts implementer.type = api as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'api';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('accepts implementer.type = shell with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'shell';
    (config as any).implementer.command = 'my-script';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects implementer.type = shell without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'shell';
    const errors = validateConfig(config);
    const cmdError = errors.find((e) => e.path === 'implementer.command');
    expect(cmdError).toBeTruthy();
    expect(cmdError!.message).toContain('Shell implementer');
  });

  it('rejects invalid implementer.type', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'invalid';
    const errors = validateConfig(config);
    const typeError = errors.find((e) => e.path === 'implementer.type');
    expect(typeError).toBeTruthy();
    expect(typeError!.message).toContain('invalid');
  });

  it('accepts implementer.outputFormat = text as valid', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.outputFormat = 'text';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects invalid implementer.outputFormat', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.outputFormat = 'invalid';
    const errors = validateConfig(config);
    const fmtError = errors.find((e) => e.path === 'implementer.outputFormat');
    expect(fmtError).toBeTruthy();
    expect(fmtError!.message).toContain('invalid');
  });

  it('accepts config with no implementer.type (backward compat)', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    // type is not set by default - should be valid
    expect((config as any).implementer.type).toBe(undefined);
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('accepts implementer.type = agent with command set', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'agent';
    (config as any).implementer.command = 'claude-zai';
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('rejects implementer.type = agent without command', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.type = 'agent';
    const errors = validateConfig(config);
    const cmdError = errors.find((e) => e.path === 'implementer.command');
    expect(cmdError).toBeTruthy();
    expect(cmdError!.message).toContain('Agent implementer');
  });

  it('rejects timeout <= 0', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 0;
    const errors = validateConfig(config);
    const timeoutError = errors.find((e) => e.path === 'implementer.timeout');
    expect(timeoutError).toBeTruthy();
  });

  it('rejects timeout > 600000', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 700000;
    const errors = validateConfig(config);
    const timeoutError = errors.find((e) => e.path === 'implementer.timeout');
    expect(timeoutError).toBeTruthy();
  });

  it('accepts valid timeout', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.timeout = 300000;
    const errors = validateConfig(config);
    expect(errors.length).toBe(0);
  });

  it('requires apiKey for agent-sdk when ANTHROPIC_API_KEY is not set', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = createDefaultConfig() as unknown as Record<string, unknown>;
      (config as any).planner.tool = 'agent-sdk';
      const errors = validateConfig(config);
      const apiKeyError = errors.find((e) => e.path === 'planner.apiKey');
      expect(apiKeyError).toBeTruthy();
      expect(apiKeyError!.message).toContain('Agent SDK');
    } finally {
      if (original !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = original;
      }
    }
  });
});

describe('writeConfigSelection', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates config file with selected planner and implementer', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-spec-test-'));
    writeConfigSelection(
      tmpDir,
      { tool: 'codex' },
      { provider: 'ollama', model: 'llama3:8b' },
    );
    const configFile = path.join(tmpDir, '.tiny-spec', 'config.yaml');
    expect(fs.existsSync(configFile)).toBe(true);
    const config = loadConfig(tmpDir);
    expect(config.planner.tool).toBe('codex');
    expect(config.implementer.provider).toBe('ollama');
    expect(config.implementer.model).toBe('llama3:8b');
  });

  it('sets shell command for custom planner', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-spec-test-'));
    writeConfigSelection(
      tmpDir,
      { tool: 'shell', command: 'my-cli --json' },
      { provider: 'ollama', model: 'qwen2.5-coder:7b' },
    );
    const config = loadConfig(tmpDir);
    expect(config.planner.tool).toBe('shell');
    expect(config.planner.command).toBe('my-cli --json');
  });

  it('uses custom apiBase when provided', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-spec-test-'));
    writeConfigSelection(
      tmpDir,
      { tool: 'claude-code' },
      { provider: 'custom', model: 'my-model', apiBase: 'http://localhost:9999/v1' },
    );
    const config = loadConfig(tmpDir);
    expect(config.implementer.apiBase).toBe('http://localhost:9999/v1');
    expect(config.implementer.provider).toBe('custom');
  });

  it('preserves existing config fields when updating', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-spec-test-'));
    const dirPath = path.join(tmpDir, '.tiny-spec');
    fs.mkdirSync(dirPath, { recursive: true });
    const initial = createDefaultConfig();
    initial.workflow.maxRetries = 5;
    initial.validation.testCommand = 'yarn test';
    fs.writeFileSync(
      path.join(dirPath, 'config.yaml'),
      YAML.stringify({ planner: { tool: 'claude-code' }, implementer: { provider: 'ollama', model: 'qwen2.5-coder:7b', api_base: 'http://localhost:11434/v1', context_length: 32768, temperature: 0.3 }, validation: { typecheck: true, lint: true, test: true, test_command: 'yarn test' }, workflow: { auto_approve_spec: false, auto_approve_plan: false, max_retries: 5, commit_per_task: true } }),
      'utf-8',
    );
    writeConfigSelection(
      tmpDir,
      { tool: 'aider' },
      { provider: 'lm-studio', model: 'codellama' },
    );
    const config = loadConfig(tmpDir);
    expect(config.planner.tool).toBe('aider');
    expect(config.implementer.provider).toBe('lm-studio');
    expect(config.workflow.maxRetries).toBe(5);
    expect(config.validation.testCommand).toBe('yarn test');
  });
});
