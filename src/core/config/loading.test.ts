import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, loadConfig } from './loading.js';
import { toYaml } from './transforms.js';
import type { PlannerConfig } from '../types/index.js';
import { TINY_SPEC_DIR } from '../paths.js';

function expectCli(p: PlannerConfig): Extract<PlannerConfig, { kind: 'cli' }> {
  if (p.kind !== 'cli') throw new Error(`Expected cli planner, got ${p.kind}`);
  return p;
}


const TMP = join(import.meta.dirname, '.tmp-config-loading-test');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfigYaml(projectDir: string, obj: Record<string, unknown>) {
  const dir = join(projectDir, TINY_SPEC_DIR);
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
      expect(expectCli(config.planner).tool).toBe('claude-code');
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
      expect(expectCli(config.planner).tool).toBe('codex');
      expect(config.implementer.temperature).toBe(0.7);
      // v2 uses 'provider' instead of 'tool' for API implementers
      expect((config.implementer as { provider: string }).provider).toBe('ollama');
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
      // v2 uses 'provider' instead of 'tool' for API implementers
      const defaultImpl = defaults.implementer as { provider: string; contextLength: number };
      const configImpl = config.implementer as { provider: string; contextLength: number };
      expect(configImpl.provider).toBe(defaultImpl.provider);
      expect(configImpl.contextLength).toBe(defaultImpl.contextLength);
    });

    it('emits security warnings to stderr via console.warn', () => {
      const dir = join(TMP, 'security-warn');
      const orig = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeConfigYaml(dir, {
          planner: { kind: 'api', provider: 'anthropic', model: 'm', api_key: 'sk-ant-test' },
        });

        loadConfig(dir);
        expect(spy).toHaveBeenCalled();
        const calls = spy.mock.calls.map(c => c[0] as string);
        expect(calls.some(c => c.startsWith('⚠') && c.includes('ANTHROPIC_API_KEY'))).toBe(true);
      } finally {
        spy.mockRestore();
        if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = orig;
      }
    });

    it('does not emit warnings when no api keys in config', () => {
      const dir = join(TMP, 'no-warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeConfigYaml(dir, {
          implementer: { model: 'codellama:13b' },
        });

        loadConfig(dir);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('returns defaults when YAML parses to a primitive', () => {
      const dir = join(TMP, 'yaml-primitive');
      const configDir = join(dir, TINY_SPEC_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '42', 'utf-8');

      const config = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
    });

    it('returns defaults when YAML parses to an array', () => {
      const dir = join(TMP, 'yaml-array');
      const configDir = join(dir, TINY_SPEC_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '- item1\n- item2', 'utf-8');

      const config = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
    });

    it('migrates commitPerTask true to commitStrategy per-task', () => {
      const dir = join(TMP, 'commit-per-task-true');
      writeConfigYaml(dir, {
        workflow: { commit_per_task: true },
      });

      const config = loadConfig(dir);
      expect(config.workflow.commitStrategy).toBe('per-task');
    });

    it('returns defaults for an empty YAML file', () => {
      const dir = join(TMP, 'empty-yaml');
      const configDir = join(dir, TINY_SPEC_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '', 'utf-8');

      const config = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
    });

    it('throws a helpful error for malformed YAML', () => {
      const dir = join(TMP, 'malformed-yaml');
      const configDir = join(dir, TINY_SPEC_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'implementer:\n  model: "unmatched quote\n  tool: broken:', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/Malformed YAML/);
    });
  });

  describe('toYaml', () => {
    it('converts camelCase to snake_case in output', () => {
      const obj = {
        workflow: { maxRetries: 3, commitStrategy: 'per-task', autoApproveSpec: false },
      };
      const result = toYaml(obj);
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.max_retries).toBe(3);
      expect(workflow.commit_strategy).toBe('per-task');
      expect(workflow.auto_approve_spec).toBe(false);
      expect(workflow.maxRetries).toBeUndefined();
    });
  });

});
