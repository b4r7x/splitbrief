import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { writeConfigYaml as persistConfigYaml } from '#testing/helpers/config-io.js';
import { join } from 'node:path';
import YAML from 'yaml';
import { configStore } from './config.js';
import { feedbackStore } from '../ui/feedback.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { expectApi, expectCli } from '#testing/helpers/config-narrowing.js';
import { SPLITBRIEF_DIR, TREES_DIR, CONFIG_FILE } from '../../core/paths.js';
import { createDefaultConfig, loadConfig } from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import { deriveConfigEdits, editsForSave } from './config-persistence.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let tmpDir: string;

function writeConfigYaml(extras: Record<string, unknown> = {}) {
  const base = {
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      api_base: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      context_length: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, test_command: 'npm test' },
    workflow: {
      max_retries: 3,
      mode: 'standard',
    },
    theme: 'terminal',
    sessions: { scope: 'project' },
    ...extras,
  };
  persistConfigYaml(tmpDir, base);
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
    const implementer = expectApi(config.implementer);
    expect(implementer.provider).toBe('ollama');
    expect(implementer.model).toBe('qwen3-coder:30b');
    expect(implementer.contextLength).toBeUndefined();
  });

  it('applies implementer override to provider and model', () => {
    writeConfigYaml();
    process.env.DEEPSEEK_API_KEY = 'test-key';
    configStore.load(tmpDir, { implementer: { tool: 'deepseek', model: 'deepseek-r1' } });
    const config = loadedConfig();
    expect(expectApi(config.implementer).provider).toBe('deepseek');
    expect(config.implementer.model).toBe('deepseek-r1');
  });

  itUnix('prints stable loader warnings once after resolveEffectiveConfig', () => {
    writeConfigYaml();
    const configPath = join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE);
    chmodSync(configPath, 0o666);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    configStore.load(tmpDir);

    const permissionWarnings = stderrChunks.filter((chunk) => chunk.includes('overly permissive'));
    expect(permissionWarnings).toHaveLength(1);
    vi.restoreAllMocks();
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
    const written = YAML.parse(readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'));
    expect(written.theme).toBe('mono');
  });

  it('does not persist an implementer model override when saving an unrelated setting', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = configStore.save(structuredClone({ ...loadedConfig(), theme: 'mono' as const }));

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

    const result = configStore.save({
      ...loadedConfig(),
      implementer: {
        ...loadedConfig().implementer,
        temperature: 0.7,
      },
    });

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.model).toBe('cli-override');
    expect(loadedConfig().implementer.temperature).toBe(0.7);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.implementer.model).toBe('qwen2.5-coder:7b');
    expect(diskConfig.implementer.temperature).toBe(0.7);
  });

  it('does not persist an unchanged implementer model override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = configStore.save({
      ...loadedConfig(),
      implementer: {
        ...loadedConfig().implementer,
        model: 'cli-override',
      },
    });

    expect(result.ok).toBe(true);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(diskConfig.implementer.model).toBe('qwen2.5-coder:7b');
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

  it('records boot-detected provenance only when the value is flagged detected', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    expect(configStore.getDetectedContextLength()).toBeUndefined();

    configStore.setContextLength(131072, true);
    expect(loadedConfig().implementer.contextLength).toBe(131072);
    expect(configStore.getDetectedContextLength()).toBe(131072);

    configStore.setContextLength(16384, false);
    expect(loadedConfig().implementer.contextLength).toBe(16384);
    expect(configStore.getDetectedContextLength()).toBeUndefined();
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
    const result = configStore.save({ ...loadedConfig(), theme: 'mono' });
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

  it('writes a complete versioned config when saving with no existing file', () => {
    configStore.load(tmpDir);
    const updated = { ...loadedConfig(), theme: 'mono' as const };

    const result = configStore.save(updated);

    expect(result.ok).toBe(true);
    const written = YAML.parse(readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'));
    expect(written.theme).toBe('mono');
    expect(written.version).toBe(3);
    const { config: diskConfig, warnings } = loadConfig(tmpDir);
    expect(diskConfig.theme).toBe('mono');
    expect(diskConfig.version).toBe(3);
    expect(warnings.some((w) => w.includes('config.version is missing'))).toBe(false);
  });
});

describe('config persistence semantic diff', () => {
  it('derives simultaneous top-level and nested profile edits without unchanged values', () => {
    const before: Config = {
      ...createDefaultConfig(),
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: {
            kind: 'cli',
            tool: 'codex',
            model: 'gpt-5.4-mini',
            label: 'Fast',
            costTier: 'standard',
          },
        },
      },
    };
    const after: Config = {
      ...before,
      theme: 'mono',
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: {
            kind: 'cli',
            tool: 'codex',
            model: 'gpt-5.4-mini',
            label: 'Fast',
            costTier: 'cheap',
          },
        },
      },
    };

    const edits = deriveConfigEdits(before, after);

    expect(edits).toHaveLength(2);
    expect(edits).toEqual(
      expect.arrayContaining([
        { path: ['theme'], value: 'mono' },
        {
          path: ['implementer_profiles', 'profiles', 'fast', 'cost_tier'],
          value: 'cheap',
        },
      ]),
    );
    expect(edits).not.toContainEqual({
      path: ['implementer_profiles', 'profiles', 'fast', 'model'],
      value: 'gpt-5.4-mini',
    });
    expect(editsForSave(before, after)).toEqual(edits);
  });
});

describe('configStore.save preserves the raw config document', () => {
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

  function writeRawConfig(yaml: string) {
    mkdirSync(join(tmpDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), yaml, 'utf-8');
  }

  function readRawConfig(): string {
    return readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8');
  }

  const HAND_EDITED = `# splitbrief config — hand edited, keep me
version: 3
implementer:
  model: qwen2.5-coder:7b # my favourite model
  context_length: 8192
theme: terminal
my_custom_key: keep-this-too
`;

  it('semantic diff persists simultaneous top-level and named-profile changes only', () => {
    const beforeRaw = `# preserve this header exactly
version: 3
implementer_profiles:
  default: fast
  profiles:
    fast:
      kind: cli
      tool: codex
      model: "gpt-5.4-mini" # keep quoting and comment
      label: 'Fast profile'
      cost_tier: standard
theme: terminal
my_custom_key: "keep: this # exactly"
`;
    writeRawConfig(beforeRaw);
    configStore.load(tmpDir);

    const before = loadedConfig();
    const fastProfile = before.implementerProfiles?.profiles.fast;
    if (!fastProfile) throw new Error('Expected the fast implementer profile');
    const updated: Config = {
      ...before,
      theme: 'mono',
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: { ...fastProfile, costTier: 'cheap' },
        },
      },
    };

    expect(configStore.save(updated).ok).toBe(true);

    const afterRaw = readRawConfig();
    expect(
      afterRaw
        .replace('cost_tier: cheap', 'cost_tier: standard')
        .replace('theme: mono', 'theme: terminal'),
    ).toBe(beforeRaw);
    const reloaded = loadConfig(tmpDir).config;
    expect(reloaded.theme).toBe('mono');
    expect(reloaded.implementerProfiles?.profiles.fast?.costTier).toBe('cheap');
    expect(reloaded.implementerProfiles?.profiles.fast?.model).toBe('gpt-5.4-mini');
  });

  it('preserves hand-edited document and creates .splitbrief/ and .splitbrief/trees/ gitignore entries once when absent', () => {
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false);
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const updated = { ...loadedConfig(), theme: 'mono' as const };
    const result = configStore.save(updated);

    expect(result.ok).toBe(true);
    const raw = readRawConfig();
    expect(raw).toContain('# splitbrief config — hand edited, keep me');
    expect(raw).toContain('# my favourite model');
    expect(raw).toContain('my_custom_key: keep-this-too');
    expect(raw).toMatch(/theme: mono/);
    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n').filter((line) => line === `${SPLITBRIEF_DIR}/`)).toHaveLength(1);
    expect(gitignore.split('\n').filter((line) => line === `${TREES_DIR}/`)).toHaveLength(1);
  });

  it('preserves comments, key order, and unknown keys when saving one setting', () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const updated = { ...loadedConfig(), theme: 'mono' as const };
    const result = configStore.save(updated);

    expect(result.ok).toBe(true);
    const raw = readRawConfig();
    expect(raw).toContain('# splitbrief config — hand edited, keep me');
    expect(raw).toContain('# my favourite model');
    expect(raw).toContain('my_custom_key: keep-this-too');
    expect(raw).toMatch(/theme: mono/);
    expect(raw.indexOf('implementer:')).toBeLessThan(raw.indexOf('theme:'));
  });

  it('does not bake default-merged values into the file on save', () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    configStore.save({ ...loadedConfig(), theme: 'mono' as const });

    const raw = readRawConfig();
    expect(raw).not.toContain('planner:');
    expect(raw).not.toContain('validation:');
    expect(raw).not.toContain('workflow:');
    expect(raw).not.toContain('max_retries');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['implementer', 'my_custom_key', 'theme', 'version'].sort(),
    );
  });

  it('writes the changed value with snake_case keys via the document path', () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const before = loadedConfig();
    const updated = {
      ...before,
      workflow: { ...before.workflow, mode: 'speckit' as const },
    };
    configStore.save(updated);

    const parsed = YAML.parse(readRawConfig()) as Record<string, unknown>;
    expect((parsed.workflow as Record<string, unknown>).mode).toBe('speckit');
    const { config: reloaded } = loadConfig(tmpDir);
    expect(reloaded.workflow.mode).toBe('speckit');
    expect(reloaded.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('removes keys that no longer apply after a runner kind change', () => {
    writeRawConfig(`version: 3
implementer:
  kind: api
  provider: ollama
  api_base: http://localhost:11434/v1
  model: qwen2.5-coder:7b
`);
    configStore.load(tmpDir);

    const before = loadedConfig();
    const updated = {
      ...before,
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini' },
    };
    configStore.save(updated);

    const implementer = (YAML.parse(readRawConfig()) as Record<string, unknown>)
      .implementer as Record<string, unknown>;
    expect(implementer.kind).toBe('cli');
    expect(implementer.tool).toBe('codex');
    expect(implementer.provider).toBeUndefined();
    expect(implementer.api_base).toBeUndefined();
  });
});
