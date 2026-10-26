import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getIsolationStrategy } from '../accessors/values.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './io.js';
import { SPLITBRIEF_DIR } from '../../paths.js';
import { expectCli } from '#testing/helpers/config-narrowing.js';
import {
  optionalSectionsYaml,
  writeConfigYaml,
  writeConfigYamlText,
} from '#testing/helpers/config-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let TMP: string;

beforeAll(() => {
  TMP = createTempDir('config-io-merge');
});

afterAll(() => {
  cleanupTempDir(TMP);
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

    it('loads a pre-S3 workflow block with one notice per retired key', () => {
      const dir = join(TMP, 'pre-s3-workflow');
      writeConfigYamlText(
        dir,
        [
          'version: 3',
          'planner:',
          '  kind: cli',
          '  tool: claude-code',
          '  model: claude-opus-5-5',
          '  effort: medium',
          'reviewer:',
          '  kind: cli',
          '  tool: codex',
          '  model: gpt-6-astra',
          '  effort: medium',
          'implementer:',
          '  kind: cli',
          '  tool: opencode',
          '  model: opencode-go/deepseek-v4.1-flash',
          '  variant: max',
          'validation:',
          '  typecheck: true',
          '  lint: true',
          '  test: true',
          'workflow:',
          '  approve: all',
          '  max_retries: 3',
          '  mode: standard',
          '  task_review: none',
          '',
        ].join('\n'),
      );

      const { config, warnings } = loadConfig(dir);

      expect(config.workflow.approve).toBe('plan');
      expect(warnings.filter((w) => w.includes('was retired'))).toEqual([
        'workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.',
        'workflow.approve "all" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.',
        'workflow.task_review was retired and is ignored: the build no longer stops for your review after each brief. Delete workflow.task_review.',
        'workflow.max_retries was retired and is ignored: the lineage attempt allowance bounds the ladder now. Delete workflow.max_retries.',
        ...['typecheck', 'lint', 'test'].map(
          (name) =>
            `validation.${name} was retired and is ignored: the reviewer chooses the commands that verify the change, and validation.end_checks turns them on or off. Delete validation.${name}.`,
        ),
      ]);
      expect(config.validation.endChecks).toBe(true);
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
      expect(config.approval).toEqual({ feedRejectionsToPlanner: false });
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

    it('accepts camelCase hook keys from YAML', () => {
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
      });

      const { config } = loadConfig(dir);

      expect(config.hooks?.pre_task?.[0]).toMatchObject({
        command: './scripts/pre-task.sh',
        timeout_ms: 5000,
        on_failure: 'block',
      });
    });

    it('rejects a retired git.commitStrategy from YAML at its nested path', () => {
      const dir = join(TMP, 'git-commit-strategy');
      writeConfigYaml(dir, {
        workflow: { max_retries: 3, git: { commit_strategy: 'per-task' } },
      });

      expect(() => loadConfig(dir)).toThrow(
        'workflow.git.commitStrategy: commitStrategy "per-task" was removed',
      );
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
      writeConfigYaml(dir, { approval: { headless: true } });

      expect(() => loadConfig(dir)).toThrow('approval.headless: Unknown config key');
    });

    it('rejects the removed codebase.cacheDir field', () => {
      const dir = join(TMP, 'removed-codebase-cache-dir');
      writeConfigYaml(dir, { codebase: { enabled: true, cache_dir: '.custom-cache' } });

      expect(() => loadConfig(dir)).toThrow('codebase.cacheDir: Unknown config key');
    });

    it('loads validation.approve_checks and leaves it unset when the file names none', () => {
      const asks = join(TMP, 'approve-checks-ask');
      writeConfigYaml(asks, { validation: { approve_checks: 'ask' } });
      const unset = join(TMP, 'approve-checks-unset');
      writeConfigYaml(unset, { validation: { end_checks: true } });

      expect(loadConfig(asks).config.validation.approveChecks).toBe('ask');
      expect(loadConfig(unset).config.validation.approveChecks).toBeUndefined();
    });

    it.each([
      ['planner', { planner: { kind: 'shell', command: './plan', args: ['{prompt}'] } }],
      ['reviewer', { reviewer: { kind: 'agent', command: './review', args: ['--task={prompt}'] } }],
      [
        'implementer',
        { implementer: { kind: 'agent', command: './build', args: ['{prompt}'], model: 'm' } },
      ],
      [
        'implementerProfiles.profiles.fast',
        {
          implementer_profiles: {
            default: 'fast',
            profiles: {
              fast: { kind: 'shell', command: './fast', args: ['{prompt}'], model: 'm' },
            },
          },
        },
      ],
      [
        'customCommands.review',
        {
          custom_commands: {
            review: {
              label: 'Review',
              contract: 'output',
              executable: '/usr/bin/review',
              argv: ['--prompt', '{prompt}'],
            },
          },
        },
      ],
    ] as const)('refuses to load a config that puts {prompt} in the %s command', (path, yaml) => {
      const dir = join(TMP, `prompt-placeholder-${path}`);
      writeConfigYaml(dir, yaml);

      expect(() => loadConfig(dir)).toThrow(
        new RegExp(
          `${path.replaceAll('.', '\\.')}\\.(args|argv)\\S*: \\{prompt\\} is not supported; SPLITBRIEF sends the prompt on stdin`,
        ),
      );
    });

    it('rejects a validation.approve_checks value other than ask or auto', () => {
      const dir = join(TMP, 'approve-checks-invalid');
      writeConfigYaml(dir, { validation: { approve_checks: 'always' } });

      expect(() => loadConfig(dir)).toThrow(/validation\.approveChecks/);
    });

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
        workflow: { git: { commit_strategy: 'none', auto_push: true } },
      });

      expect(() => loadConfig(dir)).toThrow('workflow.git.autoPush: Unknown config key');
    });

    it('accepts every current workflow field', () => {
      const dir = join(TMP, 'workflow-full-surface');
      writeConfigYaml(dir, {
        workflow: {
          approve: 'plan',
          git: { create_branch: true },
          compaction_threshold: 50,
          compaction_format: 'structured',
        },
      });

      expect(loadConfig(dir).config.workflow).toEqual({
        approve: 'plan',
        review: 'end',
        git: { createBranch: true },
        compactionThreshold: 50,
        compactionFormat: 'structured',
      });
    });

    it('deep merges nested objects', () => {
      const dir = join(TMP, 'deep-merge');
      writeConfigYaml(dir, {
        planner: { kind: 'cli', tool: 'codex' },
        implementer: { temperature: 0.7 },
        validation: { testCommand: 'make test' },
        workflow: { approve: 'none' },
      });

      const { config } = loadConfig(dir);
      expect(expectCli(config.planner).tool).toBe('codex');
      expect(config.implementer.temperature).toBe(0.7);
      expect((config.implementer as { provider: string }).provider).toBe('ollama');
      expect(config.validation.testCommand).toBe('make test');
      expect(config.validation.endChecks).toBe(true);
      expect(config.workflow.approve).toBe('none');
      expect(getIsolationStrategy(config)).toBe('worktree');
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

    it('leaves workflow.isolation unset when the file does not name it, which reads as worktree', () => {
      const dir = join(TMP, 'pre-isolation-config');
      writeConfigYaml(dir, { workflow: { max_retries: 3 } });

      const { config } = loadConfig(dir);
      expect(config.workflow.isolation).toBeUndefined();
      expect(getIsolationStrategy(config)).toBe('worktree');
    });

    it('loads a workflow block without mode with no mode and no notice', () => {
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
          '  approve: plan',
        ].join('\n'),
        'utf-8',
      );

      const { config, warnings } = loadConfig(dir);
      expect(config.workflow).not.toHaveProperty('mode');
      expect(warnings.filter((warning) => warning.includes('was retired'))).toEqual([]);
    });
  });
});
