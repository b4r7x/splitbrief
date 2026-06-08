import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { configStore } from './config.js';
import { feedbackStore } from '../ui/feedback.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { expectApi, expectCli, expectShell } from '#testing/helpers/config-narrowing.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { createDefaultConfig, loadConfig } from '../../core/config/load/io.js';

let tmpDir: string;

function writeConfigYaml(extras: Record<string, unknown> = {}) {
  mkdirSync(join(tmpDir, DIPTYCH_DIR), { recursive: true });
  const base = {
    planner: { tool: 'claude-code' },
    implementer: {
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
      context_length: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, test_command: 'npm test' },
    workflow: {
      auto_approve_spec: false,
      auto_approve_plan: false,
      max_retries: 3,
      commit_strategy: 'none',
      mode: 'standard',
    },
    theme: 'terminal',
    sessions: { scope: 'project' },
    ...extras,
  };
  writeFileSync(join(tmpDir, DIPTYCH_DIR, 'config.yaml'), YAML.stringify(base), 'utf-8');
}

function loadedConfig() {
  const config = configStore.get().config;
  if (!config) throw new Error('Expected config to be loaded');
  return config;
}

function configWithApproval(enabled: boolean) {
  return {
    ...createDefaultConfig(),
    approval: { enabled, feedRejectionsToPlanner: true },
  };
}

describe('configStore.load', () => {
  beforeEach(() => {
    tmpDir = createTempDir('config-store-test');
    configStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    configStore.reset();
    feedbackStore.reset();
  });

  it('starts empty', () => {
    expect(configStore.get().config).toBeNull();
    expect(configStore.get().projectDir).toBe('');
  });

  it('loads config from disk', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    expect(configStore.get().projectDir).toBe(tmpDir);
    const config = loadedConfig();
    expect(expectCli(config.planner).tool).toBe('claude-code');
    expect(config.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('falls back to defaults when no config file exists', () => {
    configStore.load(tmpDir);
    const config = loadedConfig();
    expect(expectCli(config.planner).tool).toBe('claude-code');
    expect(expectApi(config.implementer).provider).toBe('ollama');
  });

  it('applies implementer override to provider and model', () => {
    writeConfigYaml();
    process.env.DEEPSEEK_API_KEY = 'test-key';
    configStore.load(tmpDir, { implementer: { tool: 'deepseek', model: 'deepseek-r1' } });
    const config = loadedConfig();
    expect(expectApi(config.implementer).provider).toBe('deepseek');
    expect(config.implementer.model).toBe('deepseek-r1');
  });

  it('applies planner overrides for cli tool', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { planner: { tool: 'aider', model: 'opus' } });
    const planner = expectCli(loadedConfig().planner);
    expect(planner.tool).toBe('aider');
    expect(planner.model).toBe('opus');
  });

  it('applies planner overrides for shell command', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { planner: { tool: 'shell', command: 'my-planner' } });
    expect(expectShell(loadedConfig().planner).command).toBe('my-planner');
  });

  it('applies contextLength override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { contextLength: 16384 });
    expect(loadedConfig().implementer.contextLength).toBe(16384);
  });

  it('applies mode override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { mode: 'full' as 'speckit' });
    expect(loadedConfig().workflow.mode).toBe('speckit');
  });

  it('throws on NaN budget override', () => {
    writeConfigYaml();
    expect(() => configStore.load(tmpDir, { budget: NaN })).toThrow('Invalid budget');
  });

  it('throws on zero budget override', () => {
    writeConfigYaml();
    expect(() => configStore.load(tmpDir, { budget: 0 })).toThrow('Invalid budget');
  });

  it('throws on negative budget override', () => {
    writeConfigYaml();
    expect(() => configStore.load(tmpDir, { budget: -5 })).toThrow('Invalid budget');
  });

  it('applies valid budget override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { budget: 10.5 });
    expect(loadedConfig().workflow.maxBudget).toBe(10.5);
  });

  it('autoApprove undefined preserves config-file values', () => {
    writeConfigYaml({
      workflow: {
        auto_approve_spec: true,
        auto_approve_plan: true,
        max_retries: 3,
        commit_strategy: 'none',
        mode: 'standard',
      },
    });
    configStore.load(tmpDir, { autoApprove: undefined });
    const config = loadedConfig();
    expect(config.workflow.autoApproveSpec).toBe(true);
    expect(config.workflow.autoApprovePlan).toBe(true);
  });
});

describe('configStore.setApprovalEnabled', () => {
  beforeEach(() => {
    tmpDir = createTempDir('config-store-test');
    configStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    configStore.reset();
    feedbackStore.reset();
  });

  it('setApprovalEnabled toggles in-memory config immutably', () => {
    configStore.__testReset({
      config: configWithApproval(true),
      projectDir: '/test',
      overrides: {},
    });
    const before = configStore.get().config;

    configStore.setApprovalEnabled(false);
    expect(configStore.get().config?.approval?.enabled).toBe(false);
    expect(configStore.get().config).not.toBe(before);

    const afterDisable = configStore.get().config;
    configStore.setApprovalEnabled(true);
    expect(configStore.get().config?.approval?.enabled).toBe(true);
    expect(configStore.get().config).not.toBe(afterDisable);
  });

  it('setApprovalEnabled is a no-op when value matches', () => {
    const initial = configWithApproval(true);
    configStore.__testReset({
      config: initial,
      projectDir: '/test',
      overrides: {},
    });
    const before = configStore.get().config;
    configStore.setApprovalEnabled(true);
    expect(configStore.get().config).toBe(before);
  });

  it('setApprovalEnabled does not write to disk', () => {
    writeConfigYaml();
    configStore.load(tmpDir);

    configStore.setApprovalEnabled(false);

    expect(configStore.get().config?.approval?.enabled).toBe(false);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.approval?.enabled).not.toBe(false);
  });
});

describe('configStore.save', () => {
  beforeEach(() => {
    tmpDir = createTempDir('config-store-test');
    configStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    configStore.reset();
    feedbackStore.reset();
  });

  it('throws when save is called before load', () => {
    expect(() => configStore.save(createDefaultConfig())).toThrow(
      'configStore.load must be called before save',
    );
  });

  it('writes config to disk and updates store', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const updated = { ...loadedConfig(), theme: 'mono' as const };
    const result = configStore.save(updated);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(loadedConfig().theme).toBe('mono');
    const written = YAML.parse(readFileSync(join(tmpDir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'));
    expect(written.theme).toBe('mono');
  });

  it('does not persist an implementer model override when saving an unrelated setting', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = configStore.save(
      structuredClone({ ...loadedConfig(), theme: 'mono' as const }),
      {
        changedPaths: ['theme'],
      },
    );

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.model).toBe('cli-override');
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.theme).toBe('mono');
    expect(diskConfig.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('does not persist an implementer model override when saving a sibling implementer setting', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = configStore.save(
      {
        ...loadedConfig(),
        implementer: {
          ...loadedConfig().implementer,
          temperature: 0.7,
        },
      },
      {
        changedPaths: ['implementer.temperature'],
      },
    );

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.model).toBe('cli-override');
    expect(loadedConfig().implementer.temperature).toBe(0.7);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.implementer.model).toBe('qwen2.5-coder:7b');
    expect(diskConfig.implementer.temperature).toBe(0.7);
  });

  it('persists an implementer model override when the model field is explicitly saved', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = configStore.save(
      {
        ...loadedConfig(),
        implementer: {
          ...loadedConfig().implementer,
          model: 'cli-override',
        },
      },
      {
        changedPaths: ['implementer.model'],
      },
    );

    expect(result.ok).toBe(true);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.implementer.model).toBe('cli-override');
  });

  it('does not persist runtime context length detection when saving an unrelated setting', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    expect(loadedConfig().implementer.contextLength).toBe(8192);
    configStore.setContextLength(16384);

    const result = configStore.save({ ...loadedConfig(), theme: 'mono' as const });

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.contextLength).toBe(16384);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.theme).toBe('mono');
    expect(diskConfig.implementer.contextLength).toBe(8192);
  });

  it('returns error result when write fails', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    // Replace projectDir with a path containing a null byte to force mkdirSync to throw
    const loaded = configStore.get();
    configStore.__testReset({
      config: loaded.config,
      projectDir: '/tmp/\0invalid',
      overrides: loaded.overrides,
    });
    const result = configStore.save(loadedConfig());
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('save does not re-apply CLI overrides', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');
    const before = loadedConfig();
    const updated = { ...before, implementer: { ...before.implementer, model: 'picker-choice' } };
    configStore.save(updated);
    expect(loadedConfig().implementer.model).toBe('picker-choice');
  });
});
