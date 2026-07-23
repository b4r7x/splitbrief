import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, initConfig, loadConfig } from './io.js';
import { DIPTYCH_DIR } from '../../paths.js';
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

    it('drops the legacy npm test default so it is not treated as user-set', () => {
      const dir = join(TMP, 'legacy-npm-test');
      writeConfigYaml(dir, {
        validation: { test: true, test_command: 'npm test' },
      });

      const { config } = loadConfig(dir);
      expect(config.validation.testCommand).toBeUndefined();
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

    it('does not write deprecated v2 workflow fields into a new default config', () => {
      const workflow = createDefaultConfig().workflow;
      expect(workflow).not.toHaveProperty('autoApproveSpec');
      expect(workflow).not.toHaveProperty('autoApprovePlan');
      expect(workflow).not.toHaveProperty('commitStrategy');
    });

    it('writes only the v3 replacements (approve, git.commitStrategy) in the default config', () => {
      const workflow = createDefaultConfig().workflow;
      expect(workflow.approve).toBe('default');
      expect(workflow.git?.commitStrategy).toBe('none');
    });

    it('does not serialize deprecated v2 workflow fields when writing a new config', () => {
      const dir = join(TMP, 'default-no-deprecated-v2');
      mkdirSync(dir, { recursive: true });
      initConfig(dir);

      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      const workflow = written.workflow as Record<string, unknown>;
      expect(workflow.auto_approve_spec).toBeUndefined();
      expect(workflow.auto_approve_plan).toBeUndefined();
      expect(workflow.commit_strategy).toBeUndefined();
      expect(workflow.approve).toBe('default');
      expect((workflow.git as Record<string, unknown>).commit_strategy).toBe('none');
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
      // v2 uses 'provider' instead of 'tool' for API implementers
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
