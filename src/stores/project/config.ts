import { createStore, storeBase } from '../create-store.js';
import {
  loadConfig,
  writeConfig,
  writeConfigDocument,
  rawDocumentHasVersion,
  configPath,
} from '../../core/config/load/io.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides/schema.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import {
  resolveImplementerProfiles,
  updateDefaultImplementerConfig,
} from '../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../core/schemas/config.js';
import { defaultApprovalConfig } from '../../core/schemas/config.js';
import { configError } from '../../core/config/errors.js';
import {
  cloneConfig,
  cloneValue,
  persistedConfigForSave,
  editsForSave,
} from './config-persistence.js';

interface ConfigState {
  config: Config | null;
  diskConfig: Config | null;
  rawYaml: string;
  projectDir: string;
  overrides: CLIOverrides;
  detectedContextLength: number | undefined;
}

const initial: ConfigState = {
  config: null,
  diskConfig: null,
  rawYaml: '',
  projectDir: '',
  overrides: {},
  detectedContextLength: undefined,
};

const store = createStore<ConfigState>(initial);

interface SaveResult {
  ok: boolean;
  error?: Error;
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const { config: loaded, loaderDiagnostics, rawYaml } = loadConfig(projectDir);
  const base = cloneConfig(loaded);
  const { config, warnings } = resolveEffectiveConfig({
    base,
    overrides,
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  store.set({
    config,
    diskConfig: cloneConfig(loaded),
    rawYaml,
    projectDir,
    overrides: cloneValue(overrides),
    detectedContextLength: undefined,
  });
}

function save(updated: Config): SaveResult {
  const { config, diskConfig, rawYaml, projectDir } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  if (!config || !diskConfig) throw configError.loadNotCalled('save');
  const persisted = persistedConfigForSave({
    persisted: diskConfig,
    effective: config,
    updated,
  });
  const edits = editsForSave(diskConfig, persisted);
  try {
    let nextRaw = rawYaml;
    if (rawDocumentHasVersion(rawYaml)) {
      if (edits.length > 0) nextRaw = writeConfigDocument(projectDir, rawYaml, edits);
    } else {
      nextRaw = writeConfig(projectDir, persisted);
    }
    store.set((s) => ({
      ...s,
      config: cloneConfig(updated),
      diskConfig: cloneConfig(persisted),
      rawYaml: nextRaw,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: configError.saveFailed(configPath(projectDir), err) };
  }
}

function useConfig(): Config {
  const config = store.use((s) => s.config);
  if (!config) throw configError.loadNotCalled('rendering');
  return config;
}

function setContextLength(contextLength: number, detected = false) {
  store.set((s) => {
    if (!s.config) return s;
    const nextDetected = detected ? contextLength : undefined;
    const current = resolveImplementerProfiles(s.config).defaultProfile.config.contextLength;
    if (current === contextLength) {
      return s.detectedContextLength === nextDetected
        ? s
        : { ...s, detectedContextLength: nextDetected };
    }
    return {
      ...s,
      detectedContextLength: nextDetected,
      config: updateDefaultImplementerConfig(s.config, (existing) => ({
        ...existing,
        contextLength,
      })),
    };
  });
}

function getDetectedContextLength(): number | undefined {
  return store.get().detectedContextLength;
}

function setApprovalEnabled(enabled: boolean) {
  store.set((s) => {
    if (!s.config) return s;
    const currentEnabled = s.config.approval?.enabled !== false;
    if (currentEnabled === enabled) return s;
    const base = s.config.approval ?? defaultApprovalConfig();
    return {
      ...s,
      config: {
        ...s.config,
        approval: { ...base, enabled },
      },
    };
  });
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<ConfigState>): void {
  const state = next ? { ...initial, ...next } : initial;
  store.set({
    ...state,
    config: state.config ? cloneConfig(state.config) : null,
    diskConfig: state.diskConfig
      ? cloneConfig(state.diskConfig)
      : state.config
        ? cloneConfig(state.config)
        : null,
    overrides: cloneValue(state.overrides),
    detectedContextLength: state.detectedContextLength,
  });
}

export const configStore = {
  ...storeBase(store),
  load,
  save,
  useConfig,
  setContextLength,
  getDetectedContextLength,
  setApprovalEnabled,
  __testReset,
};
