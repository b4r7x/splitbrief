import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, initConfig, loadConfig } from './io.js';
import { SPLITBRIEF_DIR } from '../../paths.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../schemas/runner-fields.js';
import { expectApi } from '#testing/helpers/config-narrowing.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';

const TMP = join(import.meta.dirname, '.tmp-config-io-defaults');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config defaults', () => {
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
      expect(config.workflow.taskReview).toBe('none');
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
        theme: 'mono',
      });

      const { config } = loadConfig(dir);
      expect(config.theme).toBe('mono');
      expect(config).not.toHaveProperty('shikiTheme');
    });

    it('does not write a shikiTheme field into the default config', () => {
      expect(createDefaultConfig()).not.toHaveProperty('shikiTheme');
    });

    it('does not emit a sessions block in the default config', () => {
      expect(createDefaultConfig()).not.toHaveProperty('sessions');
    });

    it('does not write removed workflow fields into a new default config', () => {
      const workflow = createDefaultConfig().workflow;
      expect(workflow).not.toHaveProperty('autoApproveSpec');
      expect(workflow).not.toHaveProperty('autoApprovePlan');
      expect(workflow).not.toHaveProperty('commitStrategy');
    });

    it('writes approve and git.commitStrategy in the default config', () => {
      const workflow = createDefaultConfig().workflow;
      expect(workflow.approve).toBe('default');
      expect(workflow.git?.commitStrategy).toBe('none');
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
      expect(workflow.approve).toBe('default');
      expect((workflow.git as Record<string, unknown>).commit_strategy).toBe('none');
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

    it('persists the subscription Claude channel in a new default config on every platform', async () => {
      const dir = join(TMP, 'default-claude-auth-channel');
      mkdirSync(dir, { recursive: true });
      await initConfig(dir);
      // A fresh config must never bill the user per token for a subscription
      // they already pay for. macOS reaches the login keychain through the host
      // account instead of the file bridge, so `session` works there too.

      const written = YAML.parse(
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        auth_channel: 'session',
      });
      expect(loadConfig(dir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        authChannel: 'session',
      });
    });

    it('creates a missing config, preserves an existing config, and force-resets it', async () => {
      const dir = join(TMP, 'init-first-save-and-force');
      const file = join(dir, SPLITBRIEF_DIR, 'config.yaml');
      mkdirSync(dir, { recursive: true });

      expect(existsSync(file)).toBe(false);
      await initConfig(dir);
      expect(loadConfig(dir).config).toEqual(createDefaultConfig());

      const existing = 'version: 3\ntheme: mono\n';
      writeFileSync(file, existing);
      await initConfig(dir);
      expect(readFileSync(file, 'utf-8')).toBe(existing);

      await initConfig(dir, { force: true });
      expect(loadConfig(dir).config).toEqual(createDefaultConfig());
    });

    it('accepts and preserves a user-supplied sessions.scope for forward-compat', () => {
      const dir = join(TMP, 'sessions-scope-forward-compat');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        sessions: { scope: 'global' },
      });

      const { config } = loadConfig(dir);
      expect(config.sessions?.scope).toBe('global');
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
