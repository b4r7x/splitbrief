import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, loadConfig, writeConfigSelection } from './loading.js';
import { toYaml } from './transforms.js';

const TMP = join(import.meta.dirname, '.tmp-config-loading-test');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfigYaml(projectDir: string, obj: Record<string, unknown>) {
  const dir = join(projectDir, '.tiny-spec');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), YAML.stringify(obj), 'utf-8');
}

describe('config loading', () => {

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const dir = join(TMP, 'no-config');
      mkdirSync(dir, { recursive: true });

      const config = loadConfig(dir);
      const defaults = createDefaultConfig();
      expect(config).toEqual(defaults);
    });

    it('loads YAML config and merges with defaults', () => {
      const dir = join(TMP, 'with-config');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
      });

      const config = loadConfig(dir);
      expect(config.implementer.model).toBe('codellama:13b');
      expect(config.planner.tool).toBe('claude-code');
    });

    it('converts snake_case keys to camelCase and migrates commitPerTask', () => {
      const dir = join(TMP, 'snake-case');
      writeConfigYaml(dir, {
        workflow: { max_retries: 5, commit_per_task: false },
      });

      const config = loadConfig(dir);
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.workflow.commitStrategy).toBe('none');
    });

    it('deep merges nested objects', () => {
      const dir = join(TMP, 'deep-merge');
      writeConfigYaml(dir, {
        planner: { tool: 'codex' },
        implementer: { temperature: 0.7 },
        validation: { lint: false },
        workflow: { auto_approve_spec: true },
      });

      const config = loadConfig(dir);
      expect(config.planner.tool).toBe('codex');
      expect(config.implementer.temperature).toBe(0.7);
      expect(config.implementer.tool).toBe('ollama');
      expect(config.validation.lint).toBe(false);
      expect(config.validation.typecheck).toBe(true);
      expect(config.workflow.autoApproveSpec).toBe(true);
      expect(config.workflow.maxRetries).toBe(3);
    });

    it('preserves defaults for unspecified fields', () => {
      const dir = join(TMP, 'partial');
      writeConfigYaml(dir, {
        implementer: { model: 'deepseek-coder:6.7b' },
      });

      const config = loadConfig(dir);
      const defaults = createDefaultConfig();
      expect(config.planner).toEqual(defaults.planner);
      expect(config.validation).toEqual(defaults.validation);
      expect(config.workflow).toEqual(defaults.workflow);
      expect(config.implementer.tool).toBe(defaults.implementer.tool);
      expect(config.implementer.contextLength).toBe(defaults.implementer.contextLength);
    });
  });

  describe('toYaml', () => {
    it('converts camelCase to snake_case in output', () => {
      const obj = {
        workflow: { maxRetries: 3, commitStrategy: 'per-task', autoApproveSpec: false },
      };
      const result = toYaml(obj) as Record<string, unknown>;
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.max_retries).toBe(3);
      expect(workflow.commit_strategy).toBe('per-task');
      expect(workflow.auto_approve_spec).toBe(false);
      expect(workflow.maxRetries).toBeUndefined();
    });
  });

  describe('writeConfigSelection', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates config file with selected planner and implementer', () => {
      tmpDir = join(TMP, 'write-basic');
      mkdirSync(tmpDir, { recursive: true });
      writeConfigSelection(
        tmpDir,
        { tool: 'codex' },
        { tool: 'ollama', model: 'llama3:8b' },
      );
      const configFile = join(tmpDir, '.tiny-spec', 'config.yaml');
      expect(existsSync(configFile)).toBe(true);
      const config = loadConfig(tmpDir);
      expect(config.planner.tool).toBe('codex');
      expect(config.implementer.tool).toBe('ollama');
      expect(config.implementer.model).toBe('llama3:8b');
    });

    it('sets shell command for custom planner', () => {
      tmpDir = join(TMP, 'write-shell');
      mkdirSync(tmpDir, { recursive: true });
      writeConfigSelection(
        tmpDir,
        { tool: 'shell', command: 'my-cli --json' },
        { tool: 'ollama', model: 'qwen2.5-coder:7b' },
      );
      const config = loadConfig(tmpDir);
      expect(config.planner.tool).toBe('shell');
      expect(config.planner.command).toBe('my-cli --json');
    });

    it('uses custom apiBase when provided', () => {
      tmpDir = join(TMP, 'write-apibase');
      mkdirSync(tmpDir, { recursive: true });
      writeConfigSelection(
        tmpDir,
        { tool: 'claude-code' },
        { tool: 'custom', model: 'my-model', apiBase: 'http://localhost:9999/v1' },
      );
      const config = loadConfig(tmpDir);
      expect(config.implementer.apiBase).toBe('http://localhost:9999/v1');
      expect(config.implementer.tool).toBe('custom');
    });

    it('preserves existing config fields when updating', () => {
      tmpDir = join(TMP, 'write-preserve');
      mkdirSync(tmpDir, { recursive: true });
      const dirPath = join(tmpDir, '.tiny-spec');
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(
        join(dirPath, 'config.yaml'),
        YAML.stringify({
          planner: { tool: 'claude-code' },
          implementer: { tool: 'ollama', model: 'qwen2.5-coder:7b' },
          validation: { test_command: 'yarn test' },
          workflow: { max_retries: 5, commit_strategy: 'none' },
        }),
        'utf-8',
      );
      writeConfigSelection(
        tmpDir,
        { tool: 'aider' },
        { tool: 'lm-studio', model: 'codellama' },
      );
      const config = loadConfig(tmpDir);
      expect(config.planner.tool).toBe('aider');
      expect(config.implementer.tool).toBe('lm-studio');
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.validation.testCommand).toBe('yarn test');
    });
  });
});
