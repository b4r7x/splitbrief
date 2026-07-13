import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
const itUnix = process.platform === 'win32' ? it.skip : it;
import YAML from 'yaml';
import { createDefaultConfig, initConfig, loadConfig, writeConfig } from './io.js';
import { toYaml } from './transform.js';
import { DIPTYCH_DIR, TREES_DIR } from '../../paths.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../schemas/runner-fields.js';
import { expectApi, expectCli } from '#testing/helpers/config-narrowing.js';

const TMP = join(import.meta.dirname, '.tmp-config-loading-test');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfigYaml(projectDir: string, obj: Record<string, unknown>) {
  const dir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), YAML.stringify(obj), 'utf-8');
}

function optionalSectionsYaml(): Record<string, unknown> {
  return {
    codebase: {
      enabled: true,
      token_budget: 1234,
      cache_dir: '.diptych-cache',
      include: ['src/**'],
      exclude: ['dist/**'],
    },
    hooks: {
      builtin: { snapshots: false },
    },
    otel: {
      enabled: true,
      service_name: 'diptych-test',
    },
    snapshots: {
      auto: {
        pre_task: true,
        post_task: false,
        pre_final_review: true,
      },
    },
    palette: {
      custom_actions: [
        {
          id: 'refresh-docs',
          label: 'Refresh docs',
          description: 'Refresh documentation',
          command: '/refresh',
        },
      ],
    },
    approval: {
      enabled: true,
      headless: true,
      tiers: {
        read: 'auto',
        write_in_scope: 'sticky',
        write_out_of_scope: 'confirm',
        destructive: 'confirm',
        package_change: 'confirm',
      },
      feed_rejections_to_planner: false,
    },
  };
}

describe('config loading', () => {
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

    itUnix('rejects initConfig when .diptych is a symlink', () => {
      const dir = createTempDir('config-symlink-init');
      const outside = createTempDir('config-symlink-init-outside');
      try {
        mkdirSync(join(outside, 'nested'), { recursive: true });
        symlinkSync(outside, join(dir, DIPTYCH_DIR));

        expect(() => initConfig(dir)).toThrow(/unsafe path|symlink/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    it('gitignores both the diptych dir and the worktree dir so neither leaks into git-status change detection', () => {
      const dir = createTempDir('config-init-gitignore');
      try {
        initConfig(dir);

        const ignored = readFileSync(join(dir, '.gitignore'), 'utf-8')
          .split('\n')
          .map((line) => line.trim());
        expect(ignored).toContain(`${DIPTYCH_DIR}/`);
        expect(ignored).toContain(`${TREES_DIR}/`);
      } finally {
        cleanupTempDir(dir);
      }
    });

    itUnix('rejects writeConfig when .diptych is a symlink', () => {
      const dir = createTempDir('config-symlink-write');
      const outside = createTempDir('config-symlink-write-outside');
      try {
        mkdirSync(join(outside, 'nested'), { recursive: true });
        symlinkSync(outside, join(dir, DIPTYCH_DIR));

        expect(() => writeConfig(dir, createDefaultConfig())).toThrow(/unsafe path|symlink/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    itUnix('rejects reading config through final symlinks', () => {
      const dir = createTempDir('config-symlink-read');
      const outside = createTempDir('config-symlink-outside');
      try {
        mkdirSync(join(dir, DIPTYCH_DIR), { recursive: true });
        writeFileSync(join(outside, 'config.yaml'), 'version: 3\n');
        symlinkSync(join(outside, 'config.yaml'), join(dir, DIPTYCH_DIR, 'config.yaml'));

        expect(() => loadConfig(dir)).toThrow(/unsafe path/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    itUnix(
      'throws instead of silently using defaults when an existing config cannot be read',
      () => {
        const dir = createTempDir('config-unreadable');
        try {
          const configDir = join(dir, DIPTYCH_DIR);
          mkdirSync(configDir, { recursive: true });
          const filePath = join(configDir, 'config.yaml');
          writeFileSync(filePath, 'implementer:\n  model: deepseek-coder:6.7b\n', 'utf-8');
          chmodSync(filePath, 0o000);

          let readDenied = true;
          try {
            readFileSync(filePath, 'utf-8');
            readDenied = false;
          } catch {
            readDenied = true;
          }
          if (!readDenied) return;

          expect(() => loadConfig(dir)).toThrow(/could not be read/);
        } finally {
          chmodSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 0o600);
          cleanupTempDir(dir);
        }
      },
    );

    it('loads YAML config and merges with defaults', () => {
      const dir = join(TMP, 'with-config');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.model).toBe('codellama:13b');
      expect(expectCli(config.planner).tool).toBe('claude-code');
    });

    it('loads workflow.taskReview from YAML', () => {
      const dir = join(TMP, 'task-review-config');
      writeConfigYaml(dir, {
        workflow: { task_review: 'failed' },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.taskReview).toBe('failed');
    });

    it('preserves schema-supported optional top-level sections while merging defaults', () => {
      const dir = join(TMP, 'optional-sections');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        ...optionalSectionsYaml(),
      });

      const { config } = loadConfig(dir);

      expect(config.codebase).toMatchObject({
        enabled: true,
        tokenBudget: 1234,
        cacheDir: '.diptych-cache',
        include: ['src/**'],
        exclude: ['dist/**'],
      });
      expect(config.hooks).toEqual({ builtin: { snapshots: false } });
      expect(config.otel).toEqual({ enabled: true, serviceName: 'diptych-test' });
      expect(config.snapshots).toEqual({
        auto: { preTask: true, postTask: false, preFinalReview: true },
      });
      expect(config.palette?.customActions?.[0]).toMatchObject({
        id: 'refresh-docs',
        label: 'Refresh docs',
        command: '/refresh',
      });
      expect(config.approval).toEqual({
        enabled: true,
        headless: true,
        tiers: {
          read: 'auto',
          write_in_scope: 'sticky',
          write_out_of_scope: 'confirm',
          destructive: 'confirm',
          package_change: 'confirm',
        },
        feedRejectionsToPlanner: false,
      });
    });

    it('preserves the trust block (trust.customRenderers) from YAML', () => {
      const dir = join(TMP, 'trust-block');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        trust: { custom_renderers: true },
      });

      const { config } = loadConfig(dir);
      expect(config.trust?.customRenderers).toBe(true);
    });

    it('preserves hook event and option keys from YAML', () => {
      const dir = join(TMP, 'hooks-snake-case');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        hooks: {
          pre_task: [
            {
              command: './scripts/pre-task.sh',
              timeout_ms: 5000,
              on_failure: 'block',
            },
          ],
        },
      });

      const { config } = loadConfig(dir);

      expect(config.hooks?.pre_task?.[0]).toMatchObject({
        command: './scripts/pre-task.sh',
        timeout_ms: 5000,
        on_failure: 'block',
      });
    });

    it('accepts camelCase hook and approval tier keys from YAML', () => {
      const dir = join(TMP, 'nested-camel-case');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        hooks: {
          preTask: [
            {
              command: './scripts/pre-task.sh',
              timeoutMs: 5000,
              onFailure: 'block',
            },
          ],
        },
        approval: {
          tiers: {
            writeInScope: 'sticky',
            writeOutOfScope: 'confirm',
            packageChange: 'confirm',
          },
        },
      });

      const { config } = loadConfig(dir);

      expect(config.hooks?.pre_task?.[0]).toMatchObject({
        command: './scripts/pre-task.sh',
        timeout_ms: 5000,
        on_failure: 'block',
      });
      expect(config.approval?.tiers).toMatchObject({
        write_in_scope: 'sticky',
        write_out_of_scope: 'confirm',
        package_change: 'confirm',
      });
    });

    it('writes loaded optional top-level sections back to YAML', () => {
      const dir = join(TMP, 'optional-sections-write');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        ...optionalSectionsYaml(),
      });

      const { config } = loadConfig(dir);
      writeConfig(dir, config);

      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.codebase).toBeDefined();
      expect(written.hooks).toBeDefined();
      expect(written.otel).toBeDefined();
      expect(written.snapshots).toBeDefined();
      expect(written.palette).toBeDefined();
      expect(written.approval).toBeDefined();
      expect((written.palette as Record<string, unknown>).custom_actions).toBeDefined();
      const approval = written.approval as Record<string, unknown>;
      const tiers = approval.tiers as Record<string, unknown>;
      expect(tiers.write_in_scope).toBe('sticky');
      expect(tiers.write_out_of_scope).toBe('confirm');
      expect(tiers.package_change).toBe('confirm');
      expect(tiers.writeInScope).toBeUndefined();
    });

    it('loads and writes implementer profiles without changing the legacy implementer', () => {
      const dir = join(TMP, 'implementer-profiles');
      writeConfigYaml(dir, {
        implementer: { model: 'legacy-local' },
        implementer_profiles: {
          default: 'local-qwen',
          profiles: {
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              api_base: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
              context_length: 32768,
              cost_tier: 'local',
            },
            'agent-cli': {
              kind: 'cli',
              tool: 'codex',
              model: 'gpt-5.4-mini',
              context_length: 200000,
              label: 'Codex CLI',
              cost_tier: 'standard',
            },
          },
        },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.model).toBe('legacy-local');
      expect(config.implementerProfiles?.default).toBe('local-qwen');
      expect(config.implementerProfiles?.profiles['agent-cli']?.label).toBe('Codex CLI');

      writeConfig(dir, config);
      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.implementer_profiles).toBeDefined();
      const profiles = written.implementer_profiles as Record<string, unknown>;
      expect(profiles.default).toBe('local-qwen');
      expect(profiles.profiles).toBeDefined();
    });

    it('converts snake_case keys to camelCase and migrates commitPerTask', () => {
      const dir = join(TMP, 'snake-case');
      writeConfigYaml(dir, {
        planner_estimate_review: true,
        auto_split_overflow: true,
        workflow: { max_retries: 5, commit_per_task: false },
      });

      const { config } = loadConfig(dir);
      expect(config.plannerEstimateReview).toBe(true);
      expect(config.autoSplitOverflow).toBe(true);
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.workflow.commitStrategy).toBe('none');

      writeConfig(dir, config);
      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.planner_estimate_review).toBe(true);
      expect(written.auto_split_overflow).toBe(true);
    });

    it('reconciles a legacy v3 workflow.commitStrategy into git.commitStrategy at load time', () => {
      const dir = join(TMP, 'v3-legacy-commit-strategy');
      writeConfigYaml(dir, {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'api', provider: 'ollama', api_base: 'http://localhost:11434/v1' },
        workflow: { max_retries: 3, commit_strategy: 'per-task' },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.git?.commitStrategy).toBe('per-task');
    });

    it('deep merges nested objects', () => {
      const dir = join(TMP, 'deep-merge');
      writeConfigYaml(dir, {
        planner: { tool: 'codex' },
        implementer: { temperature: 0.7 },
        validation: { lint: false },
        workflow: { auto_approve_spec: true },
      });

      const { config } = loadConfig(dir);
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

    it('returns security warnings in the warnings array', () => {
      const dir = join(TMP, 'security-warn');
      const orig = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      try {
        writeConfigYaml(dir, {
          planner: { kind: 'api', provider: 'anthropic', model: 'm', api_key: 'sk-ant-test' },
        });

        const { warnings } = loadConfig(dir);
        expect(warnings.some((w) => w.includes('ANTHROPIC_API_KEY'))).toBe(true);
      } finally {
        if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = orig;
      }
    });

    it('returns no warnings when no api keys in config', () => {
      const dir = join(TMP, 'no-warn');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { model: 'codellama:13b' },
      });

      const { warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
    });

    it('throws when YAML parses to a primitive', () => {
      const dir = join(TMP, 'yaml-primitive');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '42', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('throws when YAML parses to an array', () => {
      const dir = join(TMP, 'yaml-array');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '- item1\n- item2', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('does not leak api-specific defaults into cli implementer (kind mismatch)', () => {
      const dir = join(TMP, 'kind-mismatch');
      writeConfigYaml(dir, {
        version: 2,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5.4-mini',
          context_length: 32768,
          temperature: 0.3,
        },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.kind).toBe('cli');
      expect((config.implementer as Record<string, unknown>).provider).toBeUndefined();
      expect((config.implementer as Record<string, unknown>).apiBase).toBeUndefined();
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

    it('does not leak ollama defaults into a different-provider implementer (model omitted)', () => {
      const dir = join(TMP, 'provider-mismatch');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'api', provider: 'openai' },
      });

      expect(() => loadConfig(dir)).toThrow(/implementer\.model/);
    });

    it('migrates commitPerTask true to commitStrategy per-task', () => {
      const dir = join(TMP, 'commit-per-task-true');
      writeConfigYaml(dir, {
        workflow: { commit_per_task: true },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.commitStrategy).toBe('per-task');
    });

    it('throws for an empty YAML file', () => {
      const dir = join(TMP, 'empty-yaml');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('throws a helpful error for malformed YAML', () => {
      const dir = join(TMP, 'malformed-yaml');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.yaml'),
        'implementer:\n  model: "unmatched quote\n  tool: broken:',
        'utf-8',
      );

      expect(() => loadConfig(dir)).toThrow(/Malformed YAML/);
    });

    it('throws mentioning the missing field when shell implementer lacks command', () => {
      const dir = join(TMP, 'missing-command');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'shell', model: 'llama3' },
      });

      expect(() => loadConfig(dir)).toThrow(/implementer\.command/);
    });

    it('throws mentioning expected type when temperature is a string', () => {
      const dir = join(TMP, 'wrong-type-temperature');
      writeConfigYaml(dir, {
        version: 3,
        implementer: {
          kind: 'api',
          provider: 'ollama',
          model: 'llama3',
          api_base: 'http://localhost:11434/v1',
          temperature: 'hot',
        },
      });

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('implementer.temperature');
      expect(thrownMessage).toMatch(/number|type/i);
    });

    it('throws identifying invalid runner kind in the error message (v3 config)', () => {
      const dir = join(TMP, 'unknown-runner-kind');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'magic', model: 'llama3' },
      });

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('implementer.kind');
      expect(thrownMessage).toMatch(/invalid|expected|discriminator/i);
    });

    it('invalid YAML syntax error says "Malformed YAML" not a cryptic Zod path', () => {
      const dir = join(TMP, 'yaml-syntax-error');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), ':\n  bad: [unclosed', 'utf-8');

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('Malformed YAML');
      expect(thrownMessage).not.toMatch(/path.*\..*\./);
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
