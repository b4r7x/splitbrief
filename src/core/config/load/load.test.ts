import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createDefaultConfig, loadConfig, writeConfig } from './load.js';
import { toYaml } from './transform.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import { DIPTYCH_DIR } from '../../paths.js';

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
        destructive: 'confirm',
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
    });

    it('loads YAML config and merges with defaults', () => {
      const dir = join(TMP, 'with-config');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.model).toBe('codellama:13b');
      expect(expectCli(config.planner).tool).toBe('claude-code');
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
        tiers: { read: 'auto', destructive: 'confirm' },
        feedRejectionsToPlanner: false,
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

      const written = YAML.parse(readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(written.codebase).toBeDefined();
      expect(written.hooks).toBeDefined();
      expect(written.otel).toBeDefined();
      expect(written.snapshots).toBeDefined();
      expect(written.palette).toBeDefined();
      expect(written.approval).toBeDefined();
      expect((written.palette as Record<string, unknown>).custom_actions).toBeDefined();
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
      const written = YAML.parse(readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8')) as Record<string, unknown>;
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
      const written = YAML.parse(readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(written.planner_estimate_review).toBe(true);
      expect(written.auto_split_overflow).toBe(true);
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
      const defaultImpl = defaults.implementer as { provider: string; contextLength: number };
      const configImpl = config.implementer as { provider: string; contextLength: number };
      expect(configImpl.provider).toBe(defaultImpl.provider);
      expect(configImpl.contextLength).toBe(defaultImpl.contextLength);
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
        expect(warnings.some(w => w.includes('ANTHROPIC_API_KEY'))).toBe(true);
      } finally {
        if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = orig;
      }
    });

    it('returns no warnings when no api keys in config', () => {
      const dir = join(TMP, 'no-warn');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
      });

      const { warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
    });

    it('returns defaults when YAML parses to a primitive', () => {
      const dir = join(TMP, 'yaml-primitive');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '42', 'utf-8');

      const { config } = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
    });

    it('returns defaults when YAML parses to an array', () => {
      const dir = join(TMP, 'yaml-array');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '- item1\n- item2', 'utf-8');

      const { config } = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
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
      expect(config.implementer.model).toBe('llama3');
      // contextLength and temperature filled from defaults
      expect((config.implementer as Record<string, unknown>).contextLength).toBe(32768);
      expect((config.implementer as Record<string, unknown>).temperature).toBe(0.3);
    });

    it('migrates commitPerTask true to commitStrategy per-task', () => {
      const dir = join(TMP, 'commit-per-task-true');
      writeConfigYaml(dir, {
        workflow: { commit_per_task: true },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.commitStrategy).toBe('per-task');
    });

    it('returns defaults for an empty YAML file', () => {
      const dir = join(TMP, 'empty-yaml');
      const configDir = join(dir, DIPTYCH_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '', 'utf-8');

      const { config } = loadConfig(dir);
      expect(config).toEqual(createDefaultConfig());
    });

    it('throws a helpful error for malformed YAML', () => {
      const dir = join(TMP, 'malformed-yaml');
      const configDir = join(dir, DIPTYCH_DIR);
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
