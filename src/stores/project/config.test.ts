import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { writeConfigYaml as persistConfigYaml } from '#testing/helpers/config-io.js';
import { join } from 'node:path';
import YAML from 'yaml';
import { configStore } from './config.js';
import { feedbackStore } from '../ui/feedback.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { expectApi, expectCli } from '#testing/helpers/config-narrowing.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../core/paths.js';
import { loadConfig } from '../../core/config/load/io.js';
import { readConfigDocument } from '../../core/config/load/document.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import type { Config } from '../../core/schemas/config.js';
import { editsForSave } from './config-persistence.js';
import { narrowRecord } from '../../utils/type-guards.js';

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
    validation: { end_checks: true, test_command: 'npm test' },
    workflow: {
      max_retries: 3,
    },
    sessions: { scope: 'project' },
    escalation: { enabled: false },
    ...extras,
  };
  persistConfigYaml(tmpDir, base);
}

function loadedConfig() {
  const config = configStore.get().config;
  if (!config) throw new Error('Expected config to be loaded');
  return config;
}

// The retired escalation block loads as `unknown`; its marker is read through one narrowing.
function escalationEnabled(config: Config): boolean {
  return narrowRecord(config.escalation)?.enabled === true;
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
    vi.unstubAllEnvs();
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

  it('seeds and saves explicit seats when no config file exists', async () => {
    configStore.load(tmpDir, {
      planner: { command: process.execPath },
      implementer: { command: process.execPath, model: 'fixture' },
    });
    const config = loadedConfig();
    expect(configStore.get().diskConfig).toEqual(config);
    expect(configStore.get().revision).toBeNull();
    expect(existsSync(join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);

    const result = await configStore.save(config);

    expect(result.kind).toBe('saved');
    const saved = loadConfig(tmpDir).config;
    expect(saved).toEqual(config);
    expect(configStore.get().diskConfig).toEqual(saved);
    expect(configStore.get().revision).toEqual(readConfigDocument(tmpDir).revision);
    configStore.load(tmpDir);
    expect(loadedConfig()).toEqual(saved);
  });

  it('refreshes persisted metadata while keeping the prepared config and runtime provenance', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'override-model' } });
    configStore.setContextLength(131072, true);
    const prepared = {
      ...loadedConfig(),
      implementer: {
        ...loadedConfig().implementer,
        model: 'prepared-model',
      },
    };
    writeConfigYaml({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      },
    });
    const save = vi.spyOn(configStore, 'save');

    configStore.refreshFromExecution(tmpDir, prepared);

    expect(loadedConfig()).toEqual(prepared);
    expect(configStore.get().diskConfig?.implementer).toMatchObject({ variant: 'high' });
    expect(configStore.get().rawYaml).toContain('variant: high');
    expect(configStore.get().revision?.rawSha256).toBe(
      readConfigDocument(tmpDir).revision?.rawSha256,
    );
    expect(configStore.get().overrides).toEqual({ implementer: { model: 'override-model' } });
    expect(configStore.getDetectedContextLength()).toBe(131072);
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('refreshes a memory-only execution without replacing it with disk defaults', () => {
    configStore.load(tmpDir);
    const config = {
      ...loadedConfig(),
      implementer: {
        kind: 'cli' as const,
        tool: 'opencode' as const,
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      },
    };
    configStore.refreshFromExecution(tmpDir, config);
    expect(loadedConfig()).toEqual(config);
    expect(configStore.get().revision).toBeNull();
    expect(configStore.get().rawYaml).toBe('');
    expect(existsSync(join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
  });

  it('applies implementer override to provider and model', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { tool: 'lm-studio', model: 'qwen3-coder-30b' } });
    const config = loadedConfig();
    expect(expectApi(config.implementer).provider).toBe('lm-studio');
    expect(config.implementer.model).toBe('qwen3-coder-30b');
  });

  it('prints every retired-value notice once, the retired approve level included', () => {
    writeConfigYaml({
      workflow: { max_retries: 3, approve: 'all', mode: 'standard', task_review: 'none' },
    });
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    configStore.load(tmpDir);

    const retired = stderrChunks.filter((chunk) => chunk.includes('was retired'));
    expect(retired).toHaveLength(5);
    expect(retired.filter((chunk) => chunk.includes('workflow.approve "all"'))).toHaveLength(1);
    expect(retired.filter((chunk) => chunk.includes('workflow.max_retries'))).toHaveLength(1);
    expect(retired.filter((chunk) => chunk.includes('escalation was retired'))).toHaveLength(1);
    vi.restoreAllMocks();
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

  it('writes config to disk and updates store', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const updated = { ...loadedConfig(), escalation: { enabled: true } };
    const result = await configStore.save(updated);

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('saved');
    expect(escalationEnabled(loadedConfig())).toBe(true);
    const written = YAML.parse(readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'));
    expect(written.escalation.enabled).toBe(true);
  });

  it('writes plan over a retired approve level the file still holds', async () => {
    writeConfigYaml({ workflow: { max_retries: 3, approve: 'all' } });
    configStore.load(tmpDir);
    expect(loadedConfig().workflow.approve).toBe('plan');

    const result = await configStore.save({
      ...loadedConfig(),
      workflow: { ...loadedConfig().workflow, approve: 'plan' },
    });

    expect(result.ok).toBe(true);
    const written = YAML.parse(readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'));
    expect(written.workflow.approve).toBe('plan');
  });

  it('does not persist an implementer model override when saving an unrelated setting', async () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = await configStore.save(
      structuredClone({ ...loadedConfig(), escalation: { enabled: true } }),
    );

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.model).toBe('cli-override');
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(escalationEnabled(diskConfig)).toBe(true);
    expect(diskConfig.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('does not persist an implementer model override when saving a sibling implementer setting', async () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = await configStore.save({
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

  it('does not persist an unchanged implementer model override', async () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');

    const result = await configStore.save({
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

  it('does not persist runtime context length detection when saving an unrelated setting', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    expect(loadedConfig().implementer.contextLength).toBe(8192);
    configStore.setContextLength(16384);

    const result = await configStore.save({ ...loadedConfig(), escalation: { enabled: true } });

    expect(result.ok).toBe(true);
    expect(loadedConfig().implementer.contextLength).toBe(16384);
    const { config: diskConfig } = loadConfig(tmpDir);
    expect(escalationEnabled(diskConfig)).toBe(true);
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

  it('returns error result when write fails', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    // Replace projectDir with a path containing a null byte to force mkdirSync to throw
    const loaded = configStore.get();
    configStore.__testReset({
      config: loaded.config,
      projectDir: '/tmp/\0invalid',
      overrides: loaded.overrides,
    });
    const result = await configStore.save({ ...loadedConfig(), escalation: { enabled: true } });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.error).toBeInstanceOf(Error);
  });

  it('save does not re-apply CLI overrides', async () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(loadedConfig().implementer.model).toBe('cli-override');
    const before = loadedConfig();
    const updated = { ...before, implementer: { ...before.implementer, model: 'picker-choice' } };
    await configStore.save(updated);
    expect(loadedConfig().implementer.model).toBe('picker-choice');
  });

  it('writes a complete versioned config when saving with no existing file', async () => {
    configStore.load(tmpDir);
    const updated = { ...loadedConfig(), escalation: { enabled: true } };

    const result = await configStore.save(updated);

    expect(result.ok).toBe(true);
    const written = YAML.parse(readFileSync(join(tmpDir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8'));
    expect(written.escalation.enabled).toBe(true);
    expect(written.version).toBe(3);
    const { config: diskConfig, warnings } = loadConfig(tmpDir);
    expect(escalationEnabled(diskConfig)).toBe(true);
    expect(diskConfig.version).toBe(3);
    expect(warnings.some((w) => w.includes('config.version is missing'))).toBe(false);
  });

  it('reports the ignore rule only on the save that creates the config', async () => {
    configStore.load(tmpDir);

    await expect(
      configStore.save({ ...loadedConfig(), escalation: { enabled: true } }),
    ).resolves.toMatchObject({ kind: 'saved', ignoreRuleAdded: true });
    expect(readFileSync(join(tmpDir, '.gitignore'), 'utf8')).toBe(`${SPLITBRIEF_DIR}/\n`);
    await expect(
      configStore.save({ ...loadedConfig(), escalation: { enabled: false } }),
    ).resolves.toMatchObject({ kind: 'saved', ignoreRuleAdded: false });
  });

  it('does not publish config state while the atomic save is pending', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const beforeRaw = readFileSync(join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8');
    const save = configStore.save({ ...loadedConfig(), escalation: { enabled: true } });

    expect(escalationEnabled(loadedConfig())).toBe(false);
    expect(readFileSync(join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8')).toBe(beforeRaw);

    await expect(save).resolves.toMatchObject({ kind: 'saved', ok: true });
    expect(escalationEnabled(loadedConfig())).toBe(true);
  });

  it('returns conflict without publishing stale attempted config or replacing external bytes', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const path = join(tmpDir, SPLITBRIEF_DIR, CONFIG_FILE);
    const external = readFileSync(path, 'utf8').replace('max_retries: 3', 'max_retries: 7');
    writeFileSync(path, external);

    const result = await configStore.save({ ...loadedConfig(), escalation: { enabled: true } });

    expect(result).toMatchObject({ kind: 'conflict', ok: false });
    expect(escalationEnabled(loadedConfig())).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(external);
  });

  it('serializes same-process saves so a stale queued request cannot overwrite the winner', async () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const initial = loadedConfig();

    const first = configStore.save({ ...initial, escalation: { enabled: true } });
    const second = configStore.save({
      ...initial,
      workflow: { ...initial.workflow, compactionFormat: 'structured' },
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.kind).toBe('saved');
    expect(secondResult.kind).toBe('conflict');
    const disk = loadConfig(tmpDir).config;
    expect(escalationEnabled(disk)).toBe(true);
    expect(disk.workflow.compactionFormat).toBe('auto');
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
          },
        },
      },
    };
    const after: Config = {
      ...before,
      escalation: { enabled: true },
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: {
            kind: 'cli',
            tool: 'codex',
            model: 'gpt-5.4-mini',
            label: 'Fast profile',
          },
        },
      },
    };

    const rawYaml = `implementer_profiles:
  default: fast
  profiles:
    fast:
      kind: cli
      tool: codex
      model: gpt-5.4-mini
      label: Fast
`;
    const edits = editsForSave(before, after, rawYaml);

    expect(edits).toHaveLength(2);
    expect(edits).toEqual(
      expect.arrayContaining([
        { path: ['escalation'], value: { enabled: true } },
        {
          path: ['implementer_profiles', 'profiles', 'fast', 'label'],
          value: 'Fast profile',
        },
      ]),
    );
    expect(edits).not.toContainEqual({
      path: ['implementer_profiles', 'profiles', 'fast', 'model'],
      value: 'gpt-5.4-mini',
    });
    expect(editsForSave(before, after, '')).toEqual(edits);
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
escalation:
  enabled: false
my_custom_key: keep-this-too
`;

  it('semantic diff persists simultaneous top-level and named-profile changes only', async () => {
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
escalation:
  enabled: false
my_custom_key: "keep: this # exactly"
`;
    writeRawConfig(beforeRaw);
    configStore.load(tmpDir);

    const before = loadedConfig();
    const fastProfile = before.implementerProfiles?.profiles.fast;
    if (!fastProfile) throw new Error('Expected the fast implementer profile');
    const updated: Config = {
      ...before,
      escalation: { enabled: true },
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: { ...fastProfile, label: 'Fast' },
        },
      },
    };

    expect((await configStore.save(updated)).ok).toBe(true);

    const afterRaw = readRawConfig();
    expect(
      afterRaw
        .replace("label: 'Fast'", "label: 'Fast profile'")
        .replace('enabled: true', 'enabled: false'),
    ).toBe(beforeRaw);
    const reloaded = loadConfig(tmpDir).config;
    expect(escalationEnabled(reloaded)).toBe(true);
    expect(reloaded.implementerProfiles?.profiles.fast?.label).toBe('Fast');
    expect(reloaded.implementerProfiles?.profiles.fast?.model).toBe('gpt-5.4-mini');
  });

  it('preserves hand-edited document without initializing gitignore', async () => {
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false);
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const updated = { ...loadedConfig(), escalation: { enabled: true } };
    const result = await configStore.save(updated);

    expect(result.ok).toBe(true);
    const raw = readRawConfig();
    expect(raw).toContain('# splitbrief config — hand edited, keep me');
    expect(raw).toContain('# my favourite model');
    expect(raw).toContain('my_custom_key: keep-this-too');
    expect(raw).toMatch(/enabled: true/);
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false);
  });

  it('preserves comments, key order, and unknown keys when saving one setting', async () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const updated = { ...loadedConfig(), escalation: { enabled: true } };
    const result = await configStore.save(updated);

    expect(result.ok).toBe(true);
    const raw = readRawConfig();
    expect(raw).toContain('# splitbrief config — hand edited, keep me');
    expect(raw).toContain('# my favourite model');
    expect(raw).toContain('my_custom_key: keep-this-too');
    expect(raw).toMatch(/enabled: true/);
    expect(raw.indexOf('implementer:')).toBeLessThan(raw.indexOf('escalation:'));
  });

  it('does not bake default-merged values into the file on save', async () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    await configStore.save({ ...loadedConfig(), escalation: { enabled: true } });

    const raw = readRawConfig();
    expect(raw).not.toContain('planner:');
    expect(raw).not.toContain('validation:');
    expect(raw).not.toContain('workflow:');
    expect(raw).not.toContain('max_retries');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['escalation', 'implementer', 'my_custom_key', 'version'].sort(),
    );
  });

  it('writes the changed value with snake_case keys via the document path', async () => {
    writeRawConfig(HAND_EDITED);
    configStore.load(tmpDir);

    const before = loadedConfig();
    const updated = {
      ...before,
      workflow: { ...before.workflow, compactionFormat: 'structured' as const },
    };
    await configStore.save(updated);

    const parsed = YAML.parse(readRawConfig()) as Record<string, unknown>;
    expect((parsed.workflow as Record<string, unknown>).compaction_format).toBe('structured');
    const { config: reloaded } = loadConfig(tmpDir);
    expect(reloaded.workflow.compactionFormat).toBe('structured');
    expect(reloaded.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('removes keys that no longer apply after a runner kind change', async () => {
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
    await configStore.save(updated);

    const implementer = (YAML.parse(readRawConfig()) as Record<string, unknown>)
      .implementer as Record<string, unknown>;
    expect(implementer.kind).toBe('cli');
    expect(implementer.tool).toBe('codex');
    expect(implementer.provider).toBeUndefined();
    expect(implementer.api_base).toBeUndefined();
  });
});
