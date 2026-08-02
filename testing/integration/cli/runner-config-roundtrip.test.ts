import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { resolveImplementerProfiles } from '../../../src/core/config/accessors/implementer-profiles.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { ImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../src/core/schemas/planner-config.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { configStore } from '../../../src/stores/project/config.js';
import {
  commitCustomCommand,
  commitCustomModel,
  commitImplementerSelection,
  commitPlannerSelection,
  removeCustomModel,
} from '../../../src/features/runners/config-transforms.js';
import { optionalSectionsYaml, writeConfigYaml } from '#testing/helpers/config-io.js';
import { realPickerOption, realPickerOptions } from '#testing/helpers/runner-picker.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { getRunnerDisplayName } from '../../../src/core/config/accessors/runner-config.js';
import {
  API_PROVIDER_CATALOG,
  isApiProviderId,
  KNOWN_API_PROVIDER_IDS,
} from '../../../src/core/providers/api-provider-catalog.js';
import { AUTOMATIC_MODEL } from '../../../src/core/providers/automatic-model.js';
import type { RunnerRole } from '../../../src/core/runners/cli-tool-catalog.js';
import { buildRightModels } from '../../../src/features/runners/model-catalog/catalog.js';
import type { PickerOption } from '../../../src/features/runners/model-catalog/options.js';

const TMP = join(import.meta.dirname, '.tmp-runner-config-roundtrip');
const dirs: string[] = [];

const commonGeneration = {
  customModels: ['model-primary', 'model-fallback'],
  contextLength: 131_072,
  temperature: 0.4,
  timeout: 240_000,
  effort: 'high' as const,
};

const plannerCapabilities = {
  supportsConversationalPlanning: true,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: true,
};

const watchdogs = { idleWarnMs: 90_000, idleKillMs: 600_000 };

const sameTargetCases: readonly (
  | { role: 'planner'; existing: PlannerConfig }
  | { role: 'implementer'; existing: ImplementerConfig }
)[] = [
  {
    role: 'planner',
    existing: {
      kind: 'cli',
      tool: 'claude-code',
      authChannel: 'session',
      model: 'claude-opus-4-6',
      args: ['--permission-mode', 'plan'],
      outputFormat: 'stream-json',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'api',
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'payg',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:PATH',
      model: 'anthropic/claude-opus-4.6',
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'shell',
      command: 'planner-shell',
      args: ['--json'],
      outputFormat: 'jsonl',
      capabilities: plannerCapabilities,
      model: 'shell-planner-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'agent',
      command: 'planner-agent',
      args: ['--verbose'],
      outputFormat: 'text',
      capabilities: plannerCapabilities,
      model: 'agent-planner-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'agent-sdk',
      apiKey: 'env:PATH',
      model: 'claude-opus-4-6',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
      args: ['--sandbox', 'workspace-write'],
      outputFormat: 'jsonl',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'api',
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'payg',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:PATH',
      model: 'qwen/qwen3-coder',
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'shell',
      command: 'implementer-shell',
      args: ['--apply'],
      outputFormat: 'text',
      model: 'shell-implementer-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'agent',
      command: 'implementer-agent',
      args: ['--apply'],
      outputFormat: 'jsonl',
      model: 'agent-implementer-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'agent-sdk',
      apiKey: 'env:PATH',
      model: 'claude-sonnet-4-6',
      ...watchdogs,
      ...commonGeneration,
    },
  },
];

const crossTargetSource: ImplementerConfig = {
  kind: 'api',
  provider: 'openrouter',
  service: 'openrouter',
  offering: 'payg',
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'env:PATH',
  model: 'anthropic/claude-opus-4.6',
  customModels: ['anthropic/claude-opus-4.6', 'source-only-model'],
  effort: 'high',
};

interface CrossTargetCase {
  label: string;
  optionId: string;
  model: { id: string } | null;
  expected: ImplementerConfig;
}

const crossTargetCases: readonly CrossTargetCase[] = [
  {
    label: 'hosted destination with a required model',
    optionId: 'anthropic',
    model: { id: 'claude-sonnet-4-6' },
    expected: {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
    },
  },
  {
    label: 'subscription destination with an explicit model',
    optionId: 'codex',
    model: { id: 'gpt-5.4' },
    expected: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
  },
  {
    label: 'subscription destination with the model omitted',
    optionId: 'copilot',
    model: null,
    expected: { kind: 'cli', tool: 'copilot' },
  },
  {
    label: 'automatic selection as the explicit auto sentinel',
    optionId: 'copilot',
    model: { id: AUTOMATIC_MODEL },
    expected: { kind: 'cli', tool: 'copilot', model: AUTOMATIC_MODEL },
  },
  {
    label: 'local destination',
    optionId: 'ollama',
    model: { id: 'qwen3-coder:30b' },
    expected: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen3-coder:30b',
    },
  },
];

/**
 * Every cell the picker can actually emit: each role's real option list, each
 * option's real model list (the `auto` sentinel included, because the picker
 * offers it), plus model omission wherever the option's capability allows it.
 * Nothing here is hand-written, so a new tool, provider or model row joins the
 * matrix the moment the catalog admits it.
 */
interface MatrixCell {
  role: RunnerRole;
  optionId: string;
  model: string | null;
  credentialEnv: string | undefined;
}

function credentialEnvFor(option: PickerOption): string | undefined {
  if (option.kind === 'agent-sdk') return 'ANTHROPIC_API_KEY';
  if (option.kind !== 'api') return undefined;
  if (!isApiProviderId(option.id)) return undefined;
  return API_PROVIDER_CATALOG[option.id].credentialEnv ?? undefined;
}

function matrixCells(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const role of ['planner', 'implementer'] as const) {
    for (const option of realPickerOptions(role)) {
      // Shell and agent runners carry a command, not a catalog id; the UI routes
      // them through commitCustomCommand, which the named-profile suite covers.
      if (option.kind === 'shell' || option.kind === 'agent') continue;
      const credentialEnv = credentialEnvFor(option);
      const models = buildRightModels({
        isPlanner: role === 'planner',
        customModels: [],
        currentItem: option,
      }).map((model) => model.id);
      const offered: (string | null)[] = [...models];
      if (option.modelCapability.allowsOmit) offered.push(null);
      for (const model of offered) {
        cells.push({ role, optionId: option.id, model, credentialEnv });
      }
    }
  }
  return cells;
}

const MATRIX_CELLS = matrixCells();

function commitCell(cell: MatrixCell): Config {
  const base = createDefaultConfig();
  const selection = realPickerOption(cell.role, cell.optionId);
  const model = cell.model === null ? null : { id: cell.model };
  return cell.role === 'planner'
    ? commitPlannerSelection(base, selection, model)
    : commitImplementerSelection(base, selection, model);
}

function clearRunnerCredentials(): void {
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  for (const id of KNOWN_API_PROVIDER_IDS) {
    const env = API_PROVIDER_CATALOG[id].credentialEnv;
    if (env) vi.stubEnv(env, undefined);
  }
}

function yamlBlock(rawYaml: string, key: string): string | undefined {
  return rawYaml.match(new RegExp(`^${key}:\\n(?:^[ \\t].*\\n)*`, 'm'))?.[0];
}

function resolvedDefaultProfile(config: Config): ImplementerConfig {
  return resolveImplementerProfiles(config).defaultProfile.config;
}

function pickerForRunner(
  role: RunnerRole,
  runner: PlannerConfig | ImplementerConfig,
): PickerOption {
  return realPickerOption(role, getRunnerDisplayName(runner));
}

function writeRunnerConfigYaml(
  dir: string,
  args: {
    planner?: PlannerConfig;
    implementer?: ImplementerConfig;
    profile?: ImplementerConfig;
    profileName?: string;
    extra?: Record<string, unknown>;
  },
): string {
  const profileName = args.profileName ?? 'active-cloud';
  const yamlBody: Record<string, unknown> = {
    version: 3,
    planner: args.planner ?? { kind: 'cli', tool: 'claude-code' },
    implementer: args.implementer ?? { kind: 'cli', tool: 'codex', model: 'legacy-model' },
    validation: { typecheck: true, lint: true, test: true },
    workflow: { max_retries: 3, persist_transcript: true, compaction_format: 'auto' },
    ...optionalSectionsYaml(),
    ...args.extra,
  };
  if (args.profile) {
    yamlBody.implementer_profiles = {
      default: profileName,
      profiles: {
        [profileName]: {
          label: 'Active cloud',
          cost_tier: 'cheap',
          ...toYaml(args.profile as Record<string, unknown>),
        },
        'dormant-local': {
          kind: 'cli',
          tool: 'codex',
          model: 'dormant-model',
        },
      },
    };
  }
  writeConfigYaml(dir, yamlBody);
  return join(dir, SPLITBRIEF_DIR, 'config.yaml');
}

function saveAndReload(dir: string, updated: Config): Config {
  expect(configStore.save(updated).ok).toBe(true);
  configStore.load(dir);
  return loadConfig(dir).config;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  configStore.__testReset();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

describe('runner config roundtrip integration', () => {
  describe('named default implementer profile persistence', () => {
    it('persists tool, model, custom model, endpoint, credential, and custom command through save/reload', () => {
      const dir = createTempDir('named-profile-roundtrip');
      dirs.push(dir);
      const configPath = writeRunnerConfigYaml(dir, {
        profile: {
          kind: 'api',
          provider: 'together',
          service: 'together',
          offering: 'payg',
          apiBase: 'https://api.together.xyz/v1',
          apiKey: 'env:PATH',
          model: 'existing-model',
          customModels: ['existing-model'],
        },
        extra: {
          codebase: {
            enabled: true,
            token_budget: 4321,
            cache_dir: '.splitbrief',
            include: ['src/**'],
            exclude: ['dist/**'],
          },
        },
      });
      const unrelatedBlock = yamlBlock(readFileSync(configPath, 'utf-8'), 'codebase');
      expect(unrelatedBlock).toBeDefined();

      configStore.load(dir);
      let current = loadConfig(dir).config;
      const together = realPickerOption('implementer', 'together');

      current = saveAndReload(
        dir,
        commitImplementerSelection(current, together, { id: 'selected-model' }),
      );
      expect(resolvedDefaultProfile(current)).toMatchObject({
        apiBase: 'https://api.together.xyz/v1',
        apiKey: 'env:PATH',
        model: 'selected-model',
      });

      current = saveAndReload(
        dir,
        commitCustomModel({
          config: current,
          role: 'implementer',
          selection: together,
          modelName: 'custom-added',
          customModels: ['existing-model'],
        }),
      );
      expect(resolvedDefaultProfile(current)).toMatchObject({
        model: 'custom-added',
        customModels: ['existing-model', 'custom-added'],
      });

      current = saveAndReload(dir, removeCustomModel(current, 'implementer', 'custom-added'));
      expect(resolvedDefaultProfile(current)).toMatchObject({
        model: 'existing-model',
        customModels: ['existing-model'],
      });

      current = saveAndReload(
        dir,
        commitCustomCommand({
          config: current,
          role: 'implementer',
          command: 'local-implementer --stdio',
          kind: 'shell',
        }),
      );
      expect(resolvedDefaultProfile(current)).toEqual({
        kind: 'shell',
        command: 'local-implementer --stdio',
        model: 'existing-model',
      });

      current = saveAndReload(
        dir,
        commitImplementerSelection(current, realPickerOption('implementer', 'codex'), {
          id: 'gpt-5.4-mini',
        }),
      );
      expect(resolvedDefaultProfile(current)).toMatchObject({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.4-mini',
      });
      expect(loadConfig(dir).config.implementerProfiles?.profiles['dormant-local']).toMatchObject({
        kind: 'cli',
        tool: 'codex',
        model: 'dormant-model',
      });
      expect(yamlBlock(readFileSync(configPath, 'utf-8'), 'codebase')).toBe(unrelatedBlock);
    });

    it('persists simultaneous top-level and named-profile changes in one save', () => {
      const dir = createTempDir('combined-profile-save');
      dirs.push(dir);
      writeRunnerConfigYaml(dir, {
        profile: {
          kind: 'api',
          provider: 'together',
          service: 'together',
          offering: 'payg',
          apiBase: 'https://api.together.xyz/v1',
          apiKey: 'env:PATH',
          model: 'existing-model',
          customModels: ['existing-model'],
        },
        extra: { theme: 'terminal' },
      });

      configStore.load(dir);
      const before = loadConfig(dir).config;
      const activeProfile = before.implementerProfiles?.profiles['active-cloud'];
      if (!activeProfile) throw new Error('expected active-cloud profile');

      const updated: Config = {
        ...before,
        theme: 'mono',
        implementer: {
          kind: 'api',
          provider: 'together',
          service: 'together',
          offering: 'payg',
          apiBase: 'https://api.together.xyz/v1',
          apiKey: 'env:PATH',
          model: 'roundtrip-model',
          customModels: ['existing-model', 'roundtrip-model'],
        },
        implementerProfiles: {
          default: 'active-cloud',
          profiles: {
            ...before.implementerProfiles?.profiles,
            'active-cloud': {
              ...activeProfile,
              kind: 'api',
              provider: 'together',
              service: 'together',
              offering: 'payg',
              apiBase: 'https://api.together.xyz/v1',
              apiKey: 'env:PATH',
              model: 'roundtrip-model',
              customModels: ['existing-model', 'roundtrip-model'],
            },
          },
        },
      };

      const reloaded = saveAndReload(dir, updated);
      expect(reloaded.theme).toBe('mono');
      expect(resolvedDefaultProfile(reloaded)).toMatchObject({
        provider: 'together',
        apiBase: 'https://api.together.xyz/v1',
        apiKey: 'env:PATH',
        model: 'roundtrip-model',
        customModels: ['existing-model', 'roundtrip-model'],
      });
      expect(reloaded.implementerProfiles?.profiles['dormant-local']).toEqual(
        before.implementerProfiles?.profiles['dormant-local'],
      );
    });
  });

  describe('config version admission', () => {
    it('rejects a version 2 config at load time', () => {
      const dir = createTempDir('rejects-v2-config');
      dirs.push(dir);
      const splitbriefDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(splitbriefDir, { recursive: true });
      writeFileSync(
        join(splitbriefDir, 'config.yaml'),
        `version: 2
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  api_base: http://localhost:11434/v1
  model: qwen2.5:7b
`,
        'utf-8',
      );

      expect(() => loadConfig(dir)).toThrow(/Unsupported config version: 2/);
    });

    it('preserves explicit service and offering across save and reload', () => {
      const dir = createTempDir('explicit-service-offering');
      dirs.push(dir);
      const splitbriefDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(splitbriefDir, { recursive: true });
      writeFileSync(
        join(splitbriefDir, 'config.yaml'),
        `version: 3
planner:
  kind: api
  provider: anthropic
  service: anthropic
  offering: payg
  api_base: https://api.anthropic.com/v1
  api_key: env:PATH
  model: claude-opus-4
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  api_base: http://localhost:11434/v1
  model: qwen2.5:7b
implementer_profiles:
  default: active-cloud
  profiles:
    active-cloud:
      kind: api
      provider: together
      service: together
      offering: payg
      api_base: https://api.together.xyz/v1
      api_key: env:PATH
      model: existing-model
codebase:
  enabled: true
  token_budget: 9999
`,
        'utf-8',
      );

      const unrelatedBlock = yamlBlock(
        readFileSync(join(splitbriefDir, 'config.yaml'), 'utf-8'),
        'codebase',
      );
      configStore.load(dir);
      const loaded = loadConfig(dir).config;
      expect(loaded.planner).toMatchObject({ service: 'anthropic', offering: 'payg' });
      expect(loaded.implementer).toMatchObject({ service: 'ollama', offering: 'local' });
      expect(loaded.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        service: 'together',
        offering: 'payg',
      });

      const saved = saveAndReload(dir, loaded);
      expect(saved.planner).toMatchObject({ service: 'anthropic', offering: 'payg' });
      expect(saved.implementer).toMatchObject({ service: 'ollama', offering: 'local' });
      expect(saved.implementerProfiles?.profiles['active-cloud']).toMatchObject({
        service: 'together',
        offering: 'payg',
      });
      expect(yamlBlock(readFileSync(join(splitbriefDir, 'config.yaml'), 'utf-8'), 'codebase')).toBe(
        unrelatedBlock,
      );
    });
  });

  describe('same-target matrix', () => {
    it.each(
      sameTargetCases,
    )('changes only the model for $role $existing.kind through save/reload', (testCase) => {
      const dir = createTempDir(`same-target-${testCase.role}-${testCase.existing.kind}`);
      dirs.push(dir);
      const modelOverride = 'same-target-model-override';

      if (testCase.role === 'planner') {
        writeRunnerConfigYaml(dir, { planner: testCase.existing });
        configStore.load(dir);
        const before = loadConfig(dir).config;
        const updated = commitPlannerSelection(
          before,
          pickerForRunner('planner', testCase.existing),
          { id: modelOverride },
        );
        const reloaded = saveAndReload(dir, updated);
        expect(reloaded.planner).toEqual({ ...testCase.existing, model: modelOverride });
        return;
      }

      writeRunnerConfigYaml(dir, { profile: testCase.existing });
      configStore.load(dir);
      const before = loadConfig(dir).config;
      const updated = commitImplementerSelection(
        before,
        pickerForRunner('implementer', testCase.existing),
        { id: modelOverride },
      );
      const reloaded = saveAndReload(dir, updated);
      expect(resolvedDefaultProfile(reloaded)).toEqual({
        ...testCase.existing,
        model: modelOverride,
      });
      expect(reloaded.implementerProfiles?.profiles['dormant-local']).toEqual(
        before.implementerProfiles?.profiles['dormant-local'],
      );
    });
  });

  describe('cross-target matrix', () => {
    it.each(crossTargetCases)('$label through save/reload', (testCase) => {
      const dir = createTempDir(`cross-target-${testCase.label.replace(/\s+/g, '-')}`);
      dirs.push(dir);
      const selection = realPickerOption('implementer', testCase.optionId);
      const needsAnthropicKey = selection.id === 'anthropic';
      if (needsAnthropicKey) {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-integration-test');
      }

      writeRunnerConfigYaml(dir, { profile: crossTargetSource });
      configStore.load(dir);
      const before = loadConfig(dir).config;

      const updated = commitImplementerSelection(before, selection, testCase.model);
      const reloaded = saveAndReload(dir, updated);
      expect(resolvedDefaultProfile(reloaded)).toEqual(testCase.expected);
      expect(reloaded.implementerProfiles?.profiles['dormant-local']).toEqual(
        before.implementerProfiles?.profiles['dormant-local'],
      );

      if (needsAnthropicKey) {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('picker option-matrix closure', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('offers a cell for every admitted destination in both roles', () => {
      const offered = new Set(MATRIX_CELLS.map((cell) => `${cell.role}:${cell.optionId}`));
      for (const role of ['planner', 'implementer'] as const) {
        for (const option of realPickerOptions(role)) {
          if (option.kind === 'shell' || option.kind === 'agent') continue;
          expect(offered).toContain(`${role}:${option.id}`);
        }
      }
      expect(MATRIX_CELLS.some((cell) => cell.model === AUTOMATIC_MODEL)).toBe(true);
      expect(MATRIX_CELLS.some((cell) => cell.model === null)).toBe(true);
    });

    it.each(MATRIX_CELLS)('loads a $role $optionId selection of model $model', ({
      role,
      optionId,
      model,
      credentialEnv,
    }) => {
      const dir = createTempDir(`matrix-${role}-${optionId}`);
      dirs.push(dir);
      clearRunnerCredentials();
      if (credentialEnv) vi.stubEnv(credentialEnv, 'matrix-credential');

      writeConfig(dir, commitCell({ role, optionId, model, credentialEnv }));
      const reloaded = loadConfig(dir).config;

      const runner = role === 'planner' ? reloaded.planner : resolvedDefaultProfile(reloaded);
      expect(getRunnerDisplayName(runner)).toBe(optionId);
      expect(runner.model ?? null).toBe(model);
    });

    it('fails only for destinations whose credential is missing, and says which one', () => {
      clearRunnerCredentials();
      const failures = new Map<string, string>();

      for (const cell of MATRIX_CELLS) {
        const dir = createTempDir('matrix-uncredentialed');
        dirs.push(dir);
        try {
          writeConfig(dir, commitCell(cell));
          loadConfig(dir);
        } catch (err) {
          failures.set(cell.optionId, err instanceof Error ? err.message : String(err));
        }
      }

      // Enumerated, not inferred: a destination joining this list is a visible
      // diff, and a shape error would show up here as an unlisted id.
      expect([...failures.keys()].toSorted()).toEqual([
        'agent-sdk',
        'anthropic',
        'deepseek',
        'groq',
        'openai',
        'openrouter',
        'together',
      ]);
      for (const [optionId, message] of failures) {
        const env = credentialEnvFor(realPickerOption('implementer', optionId));
        expect(env).toBeDefined();
        expect(message).toContain(env);
      }
    });
  });
});
