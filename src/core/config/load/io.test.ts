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
        include: ['src/**'],
        exclude: ['dist/**'],
      });
      expect(config.hooks?.pre_task?.[0]).toMatchObject({ command: './scripts/pre-task.sh' });
      expect(config.palette?.customActions?.[0]).toMatchObject({
        id: 'refresh-docs',
        label: 'Refresh docs',
        command: '/refresh',
      });
      expect(config.approval).toEqual({
        enabled: true,
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

    it('rejects the removed workflow.persist_transcript field', () => {
      const dir = join(TMP, 'removed-workflow-persist-transcript');
      writeConfigYaml(dir, { workflow: { max_retries: 3, persist_transcript: false } });

      expect(() => loadConfig(dir)).toThrow('workflow.persistTranscript: Unknown config key');
    });

    it('rejects the removed workflow.briefReview rich variant', () => {
      const dir = join(TMP, 'removed-brief-review-rich');
      writeConfigYaml(dir, { workflow: { max_retries: 3, brief_review: 'rich' } });

      expect(() => loadConfig(dir)).toThrow(/workflow\.briefReview/);
    });

    it('rejects the removed hooks.builtin block', () => {
      const dir = join(TMP, 'removed-hooks-builtin');
      writeConfigYaml(dir, { hooks: { builtin: { snapshots: false } } });

      expect(() => loadConfig(dir)).toThrow('hooks.builtin: Unknown config key');
    });

    it('rejects the removed pre_compact hook event', () => {
      const dir = join(TMP, 'removed-hook-pre-compact');
      writeConfigYaml(dir, { hooks: { pre_compact: [{ command: './scripts/compact.sh' }] } });

      expect(() => loadConfig(dir)).toThrow('hooks.pre_compact: Unknown config key');
    });

    it('rejects the removed approval.headless field', () => {
      const dir = join(TMP, 'removed-approval-headless');
      writeConfigYaml(dir, { approval: { enabled: true, headless: true } });

      expect(() => loadConfig(dir)).toThrow('approval.headless: Unknown config key');
    });

    it('rejects the removed codebase.cacheDir field', () => {
      const dir = join(TMP, 'removed-codebase-cache-dir');
      writeConfigYaml(dir, { codebase: { enabled: true, cache_dir: '.custom-cache' } });

      expect(() => loadConfig(dir)).toThrow('codebase.cacheDir: Unknown config key');
    });

    it.each([['network'], ['validation']])(
      'rejects the removed approval tier %s',
      (tier: string) => {
        const dir = join(TMP, `removed-approval-tier-${tier}`);
        writeConfigYaml(dir, { approval: { tiers: { [tier]: 'confirm' } } });

        expect(() => loadConfig(dir)).toThrow(`approval.tiers.${tier}: Unknown config key`);
      },
    );

    it('rejects the removed sessions.scope global value', () => {
      const dir = join(TMP, 'removed-sessions-scope-global');
      writeConfigYaml(dir, { sessions: { scope: 'global' } });

      expect(() => loadConfig(dir)).toThrow(/sessions\.scope/);
    });

    it.each([
      { slug: 'otel', path: 'otel', yaml: { otel: { enabled: true, service_name: 'sb-test' } } },
      { slug: 'snapshots', path: 'snapshots', yaml: { snapshots: { auto: { pre_task: true } } } },
      { slug: 'trust', path: 'trust', yaml: { trust: { custom_renderers: true } } },
      {
        slug: 'planner-estimate-review',
        path: 'plannerEstimateReview',
        yaml: { planner_estimate_review: true },
      },
      {
        slug: 'auto-split-overflow',
        path: 'autoSplitOverflow',
        yaml: { auto_split_overflow: true },
      },
    ])('rejects the removed top-level $path key on its own', ({ slug, path, yaml }) => {
      const dir = join(TMP, `removed-top-level-${slug}`);
      writeConfigYaml(dir, yaml);

      expect(() => loadConfig(dir)).toThrow(`${path}: Unknown config key`);
    });

    it('names every removed top-level key in one load error', () => {
      const dir = join(TMP, 'removed-top-level-keys');
      writeConfigYaml(dir, {
        otel: { enabled: true, service_name: 'splitbrief-test' },
        snapshots: { auto: { pre_task: true } },
        trust: { custom_renderers: true },
        planner_estimate_review: true,
        auto_split_overflow: true,
      });

      let message = '';
      try {
        loadConfig(dir);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      const removed = ['otel', 'snapshots', 'trust', 'plannerEstimateReview', 'autoSplitOverflow'];
      for (const key of removed) {
        expect(message).toContain(`${key}: Unknown config key`);
      }
    });

    it('still tolerates a stale top-level key no release ever removed', () => {
      const dir = join(TMP, 'stale-top-level-key');
      writeConfigYaml(dir, { theme: 'terminal' });

      expect(Object.keys(loadConfig(dir).config)).not.toContain('theme');
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
          brief_review: 'simple',
          task_review: 'every',
          max_budget: 5,
          budget_pause_threshold: 0.5,
          drift_chain_threshold: 0.4,
          cost_gate: true,
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
        briefReview: 'simple',
        taskReview: 'every',
        maxBudget: 5,
        budgetPauseThreshold: 0.5,
        driftChainThreshold: 0.4,
        costGate: true,
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
