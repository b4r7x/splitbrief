import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { initConfig, loadConfig, writeConfig } from './io.js';
import { createDefaultConfig, mergeWithDefaults } from './defaults.js';
import { SPLITBRIEF_DIR } from '../../paths.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../schemas/runner-fields.js';
import { expectApi } from '#testing/helpers/config-narrowing.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';

const TMP = join(import.meta.dirname, '.tmp-config-defaults');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config defaults', () => {
  describe('createDefaultConfig', () => {
    it('does not default the retired maxRetries', () => {
      expect(createDefaultConfig().workflow.maxRetries).toBeUndefined();
    });
  });

  describe('mergeWithDefaults', () => {
    it('carries a __proto__ key through as data instead of re-pointing the merged object', () => {
      const merged = mergeWithDefaults({ ['__proto__']: { polluted: true } });

      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
      expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const dir = join(TMP, 'no-config');
      mkdirSync(dir, { recursive: true });

      const { config } = loadConfig(dir);
      const defaults = createDefaultConfig();
      expect(config).toEqual(defaults);
      expect(defaults.implementer).not.toHaveProperty('contextLength');
      expect(expectApi(defaults.implementer).model).toBe('qwen3-coder:30b');
      expect(expectApi(defaults.implementer).temperature).toBe(DEFAULT_IMPLEMENTER_TEMPERATURE);
      expect(config.workflow).not.toHaveProperty('taskReview');
    });

    it('leaves the reviewer seat unset when the config has no reviewer block', () => {
      const dir = join(TMP, 'no-reviewer');
      writeConfigYaml(dir, { planner: { kind: 'cli', tool: 'claude-code' } });

      const { config, warnings } = loadConfig(dir);
      expect(config.reviewer).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('keeps a configured reviewer block unchanged through the merge', () => {
      const dir = join(TMP, 'with-reviewer');
      writeConfigYaml(dir, {
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-mini' },
      });

      const { config } = loadConfig(dir);
      expect(config.reviewer).toEqual({ kind: 'cli', tool: 'codex', model: 'gpt-5-mini' });
    });

    it('leaves validation.testCommand undefined when the user did not set it', () => {
      const dir = join(TMP, 'no-test-command');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        validation: { test: true },
      });

      const { config } = loadConfig(dir);
      expect(config.validation.testCommand).toBeUndefined();
    });

    it('keeps a user-set validation.testCommand of "npm test"', () => {
      const dir = join(TMP, 'explicit-npm-test');
      writeConfigYaml(dir, {
        validation: { test: true, test_command: 'npm test' },
      });

      const { config } = loadConfig(dir);
      expect(config.validation.testCommand).toBe('npm test');
    });

    it('accepts and ignores a stale shikiTheme field from an old config', () => {
      const dir = join(TMP, 'stale-shiki-theme');
      writeConfigYaml(dir, {
        shiki_theme: 'github-light',
        workflow: { approve: 'none' },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.approve).toBe('none');
      expect(config).not.toHaveProperty('shikiTheme');
    });

    it('emits no retired keys, but does emit approve, in a fresh default config', () => {
      const config = createDefaultConfig();
      expect(config).not.toHaveProperty('shikiTheme');
      expect(config).not.toHaveProperty('sessions');
      expect(config).not.toHaveProperty('hooks');
      expect(config.workflow).not.toHaveProperty('autoApproveSpec');
      expect(config.workflow).not.toHaveProperty('autoApprovePlan');
      expect(config.workflow).not.toHaveProperty('commitStrategy');
      expect(config.workflow).not.toHaveProperty('git');
      expect(config.workflow).not.toHaveProperty('mode');
      expect(config.workflow.approve).toBe('plan');
    });

    it('does not serialize removed workflow fields when writing a new config', async () => {
      const dir = join(TMP, 'default-no-removed-workflow-fields');
      mkdirSync(dir, { recursive: true });
      await initConfig(dir);

      const written = YAML.parse(
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      const workflow = written.workflow as Record<string, unknown>;
      expect(workflow.auto_approve_spec).toBeUndefined();
      expect(workflow.auto_approve_plan).toBeUndefined();
      expect(workflow.commit_strategy).toBeUndefined();
      expect(workflow.git).toBeUndefined();
      expect(workflow.mode).toBeUndefined();
      expect(workflow.max_retries).toBeUndefined();
      expect(workflow.approve).toBe('plan');
    });

    it.each(['checkpoint', 'per-task'])(
      'rejects workflow.git.commit_strategy %s at load, naming the key to delete',
      (strategy) => {
        const dir = join(TMP, `retired-commit-strategy-${strategy}`);
        writeConfigYaml(dir, { workflow: { git: { commit_strategy: strategy } } });

        expect(() => loadConfig(dir)).toThrow(
          `workflow.git.commitStrategy: commitStrategy "${strategy}" was removed`,
        );
      },
    );

    it('loads commit_strategy none as inert, keeps create_branch, and omits it on rewrite', () => {
      const dir = join(TMP, 'legacy-commit-strategy-none');
      writeConfigYaml(dir, { workflow: { git: { commit_strategy: 'none', create_branch: true } } });

      const { config } = loadConfig(dir);
      expect(config.workflow.git).toEqual({ createBranch: true });

      const rewritten = YAML.parse(writeConfig(dir, config)) as Record<string, unknown>;
      expect((rewritten.workflow as Record<string, unknown>).git).toEqual({ create_branch: true });
      expect(loadConfig(dir).config).toEqual(config);
    });

    it.each(['pre_commit', 'post_commit'])(
      'rejects a populated hooks.%s list at load, naming the key to delete',
      (event) => {
        const dir = join(TMP, `retired-hook-${event}`);
        writeConfigYaml(dir, { hooks: { [event]: [{ command: './scripts/commit.sh' }] } });

        expect(() => loadConfig(dir)).toThrow(`hooks.${event}: ${event} hooks were removed`);
      },
    );

    it('drops empty legacy commit hook lists on load and rewrite, keeping other hooks', () => {
      const dir = join(TMP, 'legacy-empty-commit-hooks');
      writeConfigYaml(dir, {
        hooks: {
          pre_task: [{ command: './scripts/pre-task.sh' }],
          pre_commit: [],
          post_commit: [],
        },
      });

      const { config } = loadConfig(dir);
      expect(Object.keys(config.hooks ?? {})).toEqual(['pre_task']);
      expect(config.hooks?.pre_task?.[0]?.command).toBe('./scripts/pre-task.sh');

      const rewritten = YAML.parse(writeConfig(dir, config)) as Record<string, unknown>;
      expect(Object.keys(rewritten.hooks as Record<string, unknown>)).toEqual(['pre_task']);
      expect(loadConfig(dir).config).toEqual(config);
    });

    it('serializes the default API identity and loads it unchanged', async () => {
      const dir = join(TMP, 'default-api-identity');
      mkdirSync(dir, { recursive: true });
      await initConfig(dir);

      const written = YAML.parse(
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.implementer).toMatchObject({
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
      });
      expect(loadConfig(dir).config).toEqual(createDefaultConfig());
    });

    it('leaves the Claude auth channel to the host configuration in a new default config', async () => {
      const dir = join(TMP, 'default-claude-auth-channel');
      mkdirSync(dir, { recursive: true });
      await initConfig(dir);
      // No admitted CLI can enforce a method (docs/AUTH-METHOD-MATRIX.md), so a
      // persisted default `session` would read as a user choice and be refused.

      const written = YAML.parse(
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
      expect(loadConfig(dir).config.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    });

    it('creates a missing config, preserves an existing config, and force-resets it', async () => {
      const dir = join(TMP, 'init-first-save-and-force');
      const file = join(dir, SPLITBRIEF_DIR, 'config.yaml');
      mkdirSync(dir, { recursive: true });

      expect(existsSync(file)).toBe(false);
      await initConfig(dir);
      expect(loadConfig(dir).config).toEqual(createDefaultConfig());

      const existing = 'version: 3\nworkflow:\n  mode: quick\n';
      writeFileSync(file, existing);
      await initConfig(dir);
      expect(readFileSync(file, 'utf-8')).toBe(existing);

      await initConfig(dir, { force: true });
      expect(loadConfig(dir).config).toEqual(createDefaultConfig());
    });

    it('preserves a user-supplied sessions.scope', () => {
      const dir = join(TMP, 'sessions-scope-project');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        sessions: { scope: 'project' },
      });

      const { config } = loadConfig(dir);
      expect(config.sessions?.scope).toBe('project');
    });

    it('rejects the removed sessions.scope global value', () => {
      const dir = join(TMP, 'sessions-scope-global');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        sessions: { scope: 'global' },
      });

      expect(() => loadConfig(dir)).toThrow(/sessions\.scope/);
    });

    it('does not synthesize a sessions block when the user omits one', () => {
      const dir = join(TMP, 'sessions-scope-omitted');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
      });

      const { config } = loadConfig(dir);
      expect(config).not.toHaveProperty('sessions');
    });

    it('preserves defaults for unspecified fields', () => {
      const dir = join(TMP, 'partial');
      writeConfigYaml(dir, {
        implementer: { model: 'deepseek-coder:6.7b' },
      });

      const { config } = loadConfig(dir);
      const defaults = createDefaultConfig();
      expect(config.planner).toEqual(defaults.planner);
      expect(config.validation).toEqual(defaults.validation);
      expect(config.workflow).toEqual(defaults.workflow);
      const defaultImpl = expectApi(defaults.implementer);
      const configImpl = expectApi(config.implementer);
      expect(configImpl.provider).toBe(defaultImpl.provider);
      expect(defaultImpl.contextLength).toBeUndefined();
      expect(configImpl.contextLength).toBeUndefined();
    });

    it('still merges defaults when implementer kind matches default (api)', () => {
      const dir = join(TMP, 'kind-match');
      writeConfigYaml(dir, {
        implementer: { model: 'llama3' },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.kind).toBe('api');
      const implementer = expectApi(config.implementer);
      expect(implementer.model).toBe('llama3');
      expect(implementer.contextLength).toBeUndefined();
      expect(implementer.temperature).toBe(DEFAULT_IMPLEMENTER_TEMPERATURE);
    });
  });
});
