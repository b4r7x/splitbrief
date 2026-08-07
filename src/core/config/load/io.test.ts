import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './io.js';
import { resolveMode } from '../runtime/resolve.js';
import { SPLITBRIEF_DIR } from '../../paths.js';
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
        cacheDir: '.splitbrief-cache',
        include: ['src/**'],
        exclude: ['dist/**'],
      });
      expect(config.hooks).toEqual({ builtin: { snapshots: false } });
      expect(config.otel).toEqual({ enabled: true, serviceName: 'splitbrief-test' });
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

    it('reads git.commitStrategy from YAML', () => {
      const dir = join(TMP, 'git-commit-strategy');
      writeConfigYaml(dir, {
        workflow: { max_retries: 3, git: { commit_strategy: 'per-task' } },
      });

      const { config } = loadConfig(dir);
      expect(config.workflow.git?.commitStrategy).toBe('per-task');
    });

    it.each([
      { field: 'auto_approve_spec', value: true, path: 'workflow.autoApproveSpec' },
      { field: 'auto_approve_plan', value: true, path: 'workflow.autoApprovePlan' },
      { field: 'commit_strategy', value: 'per-task', path: 'workflow.commitStrategy' },
    ])('rejects the removed workflow.$field field and names $path', ({ field, value, path }) => {
      const dir = join(TMP, `removed-workflow-${field}`);
      writeConfigYaml(dir, { workflow: { max_retries: 3, [field]: value } });

      expect(() => loadConfig(dir)).toThrow(`${path}: Unknown config key`);
    });

    it('names the nested path when workflow.git carries an unknown key', () => {
      const dir = join(TMP, 'unknown-workflow-git-key');
      writeConfigYaml(dir, {
        workflow: { git: { commit_strategy: 'per-task', auto_push: true } },
      });

      expect(() => loadConfig(dir)).toThrow('workflow.git.autoPush: Unknown config key');
    });

    it('accepts every current workflow field', () => {
      const dir = join(TMP, 'workflow-full-surface');
      writeConfigYaml(dir, {
        workflow: {
          approve: 'all',
          max_retries: 2,
          git: { commit_strategy: 'per-task', create_branch: true },
          speckit: { min_coverage: 0.8 },
          mode: 'speckit',
          brief_review: 'rich',
          task_review: 'every',
          max_budget: 5,
          budget_pause_threshold: 0.5,
          drift_chain_threshold: 0.4,
          cost_gate: true,
          persist_transcript: false,
          compaction_threshold: 50,
          compaction_format: 'structured',
        },
      });

      expect(loadConfig(dir).config.workflow).toEqual({
        approve: 'all',
        maxRetries: 2,
        git: { commitStrategy: 'per-task', createBranch: true },
        isolation: 'worktree',
        speckit: { minCoverage: 0.8 },
        mode: 'speckit',
        briefReview: 'rich',
        taskReview: 'every',
        maxBudget: 5,
        budgetPauseThreshold: 0.5,
        driftChainThreshold: 0.4,
        costGate: true,
        persistTranscript: false,
        compactionThreshold: 50,
        compactionFormat: 'structured',
      });
    });

    it('deep merges nested objects', () => {
      const dir = join(TMP, 'deep-merge');
      writeConfigYaml(dir, {
        planner: { kind: 'cli', tool: 'codex' },
        implementer: { temperature: 0.7 },
        validation: { lint: false },
        workflow: { approve: 'none' },
      });

      const { config } = loadConfig(dir);
      expect(expectCli(config.planner).tool).toBe('codex');
      expect(config.implementer.temperature).toBe(0.7);
      expect((config.implementer as { provider: string }).provider).toBe('ollama');
      expect(config.validation.lint).toBe(false);
      expect(config.validation.typecheck).toBe(true);
      expect(config.workflow.approve).toBe('none');
      expect(config.workflow.maxRetries).toBe(3);
    });

    it.each([
      ['1', 1],
      ['2', 2],
      ['99', 99],
    ])('rejects config version %s', (_label, version) => {
      const dir = join(TMP, `unsupported-version-${String(version)}`);
      writeConfigYaml(dir, { version, implementer: { model: 'codellama:13b' } });

      expect(() => loadConfig(dir)).toThrow(/Unsupported config version: .*Supported: 3/s);
    });

    it('rejects a config without a version', () => {
      const dir = join(TMP, 'missing-version');
      const splitbriefDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(splitbriefDir, { recursive: true });
      writeFileSync(join(splitbriefDir, 'config.yaml'), 'implementer:\n  model: llama3\n', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/Unsupported config version: undefined/);
    });

    it('resolves workflow.isolation to worktree for configs predating the key', () => {
      const dir = join(TMP, 'pre-isolation-config');
      writeConfigYaml(dir, { workflow: { max_retries: 3 } });

      const { config } = loadConfig(dir);
      expect(config.workflow.isolation).toBe('worktree');
    });

    it('defaults workflow.mode to standard when raw YAML omits mode', () => {
      const dir = join(TMP, 'workflow-without-mode');
      const splitbriefDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(splitbriefDir, { recursive: true });
      writeFileSync(
        join(splitbriefDir, 'config.yaml'),
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
