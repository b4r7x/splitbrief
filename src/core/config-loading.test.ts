import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, loadConfig, toYaml } from './config.js';

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
  describe('createDefaultConfig', () => {
    it('returns config with expected default values', () => {
      const config = createDefaultConfig();
      expect(config.planner.tool).toBe('claude-code');
      expect(config.implementer.provider).toBe('ollama');
      expect(config.implementer.model).toBe('qwen2.5-coder:7b');
      expect(config.implementer.temperature).toBe(0.3);
      expect(config.validation.typecheck).toBe(true);
      expect(config.validation.lint).toBe(true);
      expect(config.validation.test).toBe(true);
      expect(config.workflow.maxRetries).toBe(3);
      expect(config.workflow.commitPerTask).toBe(true);
      expect(config.workflow.autoApproveSpec).toBe(false);
      expect(config.workflow.autoApprovePlan).toBe(false);
    });
  });

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

    it('converts snake_case keys to camelCase', () => {
      const dir = join(TMP, 'snake-case');
      writeConfigYaml(dir, {
        workflow: { max_retries: 5, commit_per_task: false },
      });

      const config = loadConfig(dir);
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.workflow.commitPerTask).toBe(false);
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
      expect(config.implementer.provider).toBe('ollama');
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
      expect(config.implementer.provider).toBe(defaults.implementer.provider);
      expect(config.implementer.contextLength).toBe(defaults.implementer.contextLength);
    });
  });

  describe('toYaml', () => {
    it('converts config to YAML string', () => {
      const obj = { planner: { tool: 'claude-code' } };
      const result = toYaml(obj);
      expect(result).toEqual({ planner: { tool: 'claude-code' } });
    });

    it('converts camelCase to snake_case in output', () => {
      const obj = {
        workflow: { maxRetries: 3, commitPerTask: true, autoApproveSpec: false },
      };
      const result = toYaml(obj) as Record<string, unknown>;
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.max_retries).toBe(3);
      expect(workflow.commit_per_task).toBe(true);
      expect(workflow.auto_approve_spec).toBe(false);
      expect(workflow.maxRetries).toBeUndefined();
    });
  });
});
