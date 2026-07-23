import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './io.js';
import { resolveMode } from '../runtime/resolve.js';
import { DIPTYCH_DIR } from '../../paths.js';
import { expectCli } from '#testing/helpers/config-narrowing.js';
import { optionalSectionsYaml, writeConfigYaml } from '#testing/helpers/config-io.js';

const TMP = join(import.meta.dirname, '.tmp-config-io-merge');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config loading', () => {
  describe('loadConfig', () => {
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

    it('migrates commitPerTask true to commitStrategy per-task', () => {
      const dir = join(TMP, 'commit-per-task-true');
      writeConfigYaml(dir, {
        workflow: { commit_per_task: true },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.commitStrategy).toBe('per-task');
    });

    it('defaults workflow.mode to standard when raw YAML omits mode', () => {
      const dir = join(TMP, 'workflow-without-mode');
      const diptychDir = join(dir, DIPTYCH_DIR);
      mkdirSync(diptychDir, { recursive: true });
      writeFileSync(
        join(diptychDir, 'config.yaml'),
        [
          'version: 3',
          'planner:',
          '  kind: cli',
          '  tool: claude-code',
          'implementer:',
          '  kind: api',
          '  provider: ollama',
          '  apiBase: http://localhost:11434/v1',
          '  model: qwen2.5-coder:7b',
          'workflow:',
          '  approve: default',
          '  max_retries: 3',
        ].join('\n'),
        'utf-8',
      );

      const { config } = loadConfig(dir);
      expect(config.workflow.mode).toBe('standard');
      expect(resolveMode({ config })).toBe('standard');
    });
  });
});
