import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { configPath, createDefaultConfig, loadConfig, writeConfig } from './io.js';
import { SPLITBRIEF_DIR } from '../../paths.js';
import { defaultCliAuthChannel } from '../../runners/cli-tool-catalog.js';
import { configStore } from '../../../stores/project/config.js';
import {
  commitCustomCommand,
  commitCustomModel,
  commitImplementerSelection,
  removeCustomModel,
} from '../../../features/runners/config-transforms.js';
import {
  optionalSectionsYaml,
  writeConfigYaml,
  writeConfigYamlText,
} from '#testing/helpers/config-io.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';

const TMP = join(import.meta.dirname, '.tmp-config-io-roundtrip');

function yamlBlock(rawYaml: string, key: string): string | undefined {
  return rawYaml.match(new RegExp(`^${key}:\\n(?:^[ \\t].*\\n)*`, 'm'))?.[0];
}

function legacyClaudeConfigYaml(comment: string): string {
  return [
    `# ${comment}`,
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    '  model: claude-opus-4-6',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  service: ollama',
    '  offering: local',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen3-coder:30b',
    'validation:',
    '  typecheck: true',
    '  lint: true',
    '  test: true',
    'workflow:',
    '  mode: standard',
    'unrelated_extension:',
    '  exact_runner_id: vendor/model@2026-08-01',
    '',
  ].join('\n');
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  configStore.__testReset();
  rmSync(TMP, { recursive: true, force: true });
});

describe('config roundtrip', () => {
  describe('loadConfig', () => {
    it('writes a default config that loadConfig reads back to the same shape', () => {
      const dir = join(TMP, 'default-roundtrip');
      mkdirSync(dir, { recursive: true });
      writeConfig(dir, createDefaultConfig());

      expect(existsSync(configPath(dir))).toBe(true);

      const { config, warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
      expect(config).toEqual(createDefaultConfig());
    });

    // The shipped shape of a subscription-CLI project: both runners delegate to
    // the tool's own configured model via the explicit `auto` sentinel.
    it('loads and re-saves a CLI auto config without rewriting the model lines', () => {
      const dir = join(TMP, 'cli-automatic-model');
      writeConfigYaml(dir, {
        planner: { kind: 'cli', tool: 'codex', model: 'auto' },
        implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
        workflow: { mode: 'standard' },
      });

      const { config, warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
      expect(config.planner).toMatchObject({ kind: 'cli', tool: 'codex', model: 'auto' });
      expect(config.implementer).toMatchObject({ kind: 'cli', tool: 'codex', model: 'auto' });

      writeConfig(dir, { ...config, workflow: { ...config.workflow, mode: 'quick' } });

      const rawYaml = readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8');
      expect(yamlBlock(rawYaml, 'planner')).toContain('model: auto');
      expect(yamlBlock(rawYaml, 'implementer')).toContain('model: auto');

      const reloaded = loadConfig(dir);
      expect(reloaded.warnings).toEqual([]);
      expect(reloaded.config.planner).toEqual(config.planner);
      expect(reloaded.config.implementer).toEqual(config.implementer);
      expect(reloaded.config.workflow.mode).toBe('quick');
    });

    it('keeps a legacy Claude channel omission read-only', () => {
      const dir = join(TMP, 'legacy-claude-channel');
      const path = join(dir, SPLITBRIEF_DIR, 'config.yaml');
      const yaml = legacyClaudeConfigYaml('Keep this comment and every key in its original order.');
      writeConfigYamlText(dir, yaml);

      const before = readFileSync(path, 'utf-8');
      const beforeHash = createHash('sha256').update(before).digest('hex');
      const beforeStat = statSync(path, { bigint: true });
      const { config } = loadConfig(dir);
      const after = readFileSync(path, 'utf-8');
      const afterStat = statSync(path, { bigint: true });

      expect(config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'claude-opus-4-6',
      });
      expect(defaultCliAuthChannel('claude-code').id).toBe('session');
      expect(after).toBe(before);
      expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash);
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    });

    it('preserves legacy comments and unrelated YAML when a later save changes another field', async () => {
      const dir = join(TMP, 'legacy-claude-channel-save');
      const path = join(dir, SPLITBRIEF_DIR, 'config.yaml');
      writeConfigYamlText(dir, legacyClaudeConfigYaml('Keep this comment.'));

      configStore.load(dir);
      const config = loadConfig(dir).config;
      expect(
        (await configStore.save({ ...config, workflow: { ...config.workflow, mode: 'quick' } })).ok,
      ).toBe(true);

      const saved = readFileSync(path, 'utf-8');
      expect(saved).toContain('# Keep this comment.');
      expect(saved).toContain('model: claude-opus-4-6');
      expect(saved).toContain('exact_runner_id: vendor/model@2026-08-01');
      expect(saved).not.toContain('auth_channel:');
      expect(saved.indexOf('planner:')).toBeLessThan(saved.indexOf('implementer:'));
      expect(saved.indexOf('implementer:')).toBeLessThan(saved.indexOf('unrelated_extension:'));
      expect(loadConfig(dir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'claude-opus-4-6',
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
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
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
              service: 'ollama',
              offering: 'local',
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
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.implementer_profiles).toBeDefined();
      const profiles = written.implementer_profiles as Record<string, unknown>;
      expect(profiles.default).toBe('local-qwen');
      expect(profiles.profiles).toBeDefined();
    });

    it('persists picker changes to the active named implementer profile', async () => {
      const dir = join(TMP, 'named-implementer-profile');
      writeConfigYaml(dir, {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex', model: 'legacy-model' },
        implementer_profiles: {
          default: 'active-cloud',
          profiles: {
            'active-cloud': {
              kind: 'api',
              provider: 'together',
              service: 'together',
              offering: 'payg',
              api_base: 'https://api.together.ai/v1',
              api_key: 'env:PATH',
              model: 'existing-model',
              custom_models: ['existing-model'],
              label: 'Active cloud',
              cost_tier: 'cheap',
            },
            'dormant-local': {
              kind: 'cli',
              tool: 'codex',
              model: 'dormant-model',
            },
          },
        },
        validation: { typecheck: true, lint: true, test: true },
        workflow: {
          max_retries: 3,
          persist_transcript: true,
          compaction_format: 'auto',
        },
        codebase: {
          enabled: true,
          token_budget: 4321,
          cache_dir: '.splitbrief',
          include: ['src/**'],
          exclude: ['dist/**'],
        },
      });

      const path = join(dir, SPLITBRIEF_DIR, 'config.yaml');
      const before = readFileSync(path, 'utf-8');
      const unrelatedBlock = yamlBlock(before, 'codebase');
      expect(unrelatedBlock).toBeDefined();

      configStore.load(dir);
      let current = loadConfig(dir).config;
      const together = realPickerOption('implementer', 'together');

      current = commitImplementerSelection({
        config: current,
        selection: together,
        model: { id: 'selected-model' },
      }).config;
      expect((await configStore.save(current)).ok).toBe(true);
      expect(loadConfig(dir).config.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        apiBase: 'https://api.together.ai/v1',
        apiKey: 'env:PATH',
        model: 'selected-model',
      });

      current = commitCustomModel({
        config: current,
        role: 'implementer',
        selection: together,
        modelName: 'custom-added',
        customModels: ['existing-model'],
      });
      expect((await configStore.save(current)).ok).toBe(true);
      expect(loadConfig(dir).config.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        model: 'custom-added',
        customModels: ['existing-model', 'custom-added'],
      });

      current = removeCustomModel(current, 'implementer', 'custom-added');
      expect((await configStore.save(current)).ok).toBe(true);
      expect(loadConfig(dir).config.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        model: 'existing-model',
        customModels: ['existing-model'],
      });

      current = commitCustomCommand({
        config: current,
        role: 'implementer',
        command: 'local-implementer --stdio',
        kind: 'shell',
      });
      expect((await configStore.save(current)).ok).toBe(true);
      current = loadConfig(dir).config;
      expect(current.implementerProfiles?.profiles['active-cloud']).toEqual({
        kind: 'shell',
        command: 'local-implementer --stdio',
        model: 'existing-model',
        label: 'Active cloud',
        costTier: 'cheap',
      });

      const commandYaml = YAML.parse(readFileSync(path, 'utf-8')) as {
        implementer_profiles?: {
          profiles?: Record<string, Record<string, unknown>>;
        };
      };
      expect(commandYaml.implementer_profiles?.profiles?.['active-cloud']).toEqual({
        kind: 'shell',
        command: 'local-implementer --stdio',
        model: 'existing-model',
        label: 'Active cloud',
        cost_tier: 'cheap',
      });

      current = commitImplementerSelection({
        config: current,
        selection: realPickerOption('implementer', 'codex'),
        model: { id: 'gpt-5.4-mini' },
      }).config;
      expect((await configStore.save(current)).ok).toBe(true);
      const reloaded = loadConfig(dir).config;
      expect(reloaded.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.4-mini',
      });
      expect(reloaded.implementerProfiles?.profiles['dormant-local']).toMatchObject({
        kind: 'cli',
        tool: 'codex',
        model: 'dormant-model',
      });
      expect(yamlBlock(readFileSync(path, 'utf-8'), 'codebase')).toBe(unrelatedBlock);
    });

    it('converts snake_case keys to camelCase', () => {
      const dir = join(TMP, 'snake-case');
      writeConfigYaml(dir, {
        planner_estimate_review: true,
        auto_split_overflow: true,
        workflow: { max_retries: 5, git: { commit_strategy: 'checkpoint' } },
      });

      const { config } = loadConfig(dir);
      expect(config.plannerEstimateReview).toBe(true);
      expect(config.autoSplitOverflow).toBe(true);
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.workflow.git?.commitStrategy).toBe('checkpoint');

      writeConfig(dir, config);
      const written = YAML.parse(
        readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.planner_estimate_review).toBe(true);
      expect(written.auto_split_overflow).toBe(true);
    });
  });
});
