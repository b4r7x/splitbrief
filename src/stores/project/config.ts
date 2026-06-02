import { createStore, storeBase } from '../create-store.js';
import { loadConfig, writeConfig, configPath } from '../../core/config/load/load.js';
import {
  applyCLIOverrides,
  applyRunnerOverrides,
  type CLIOverrides,
} from '../../core/config/runtime/overrides.js';
import type { Config } from '../../core/schemas/config.js';
import { defaultApprovalConfig } from '../../core/schemas/config.js';
import { configError } from '../../core/config/errors.js';
import { warnStderr } from '../../lib/warn.js';
import {
  cloneConfig,
  cloneValue,
  persistedConfigForSave,
  type SaveOptions,
} from './config-persistence.js';

interface ConfigState {
  config: Config | null;
  diskConfig: Config | null;
  projectDir: string;
  overrides: CLIOverrides;
}

const initial: ConfigState = {
  config: null,
  diskConfig: null,
  projectDir: '',
  overrides: {},
};

const store = createStore<ConfigState>(initial);

interface SaveResult {
  ok: boolean;
  error?: Error;
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const { config: loaded, warnings } = loadConfig(projectDir);
  for (const w of warnings) warnStderr(`⚠ ${w}`);
  const base = cloneConfig(loaded);
  const config = applyCLIOverrides(base, overrides);
  store.set({
    config,
    diskConfig: cloneConfig(loaded),
    projectDir,
    overrides: cloneValue(overrides),
  });
}

function save(updated: Config, options?: SaveOptions): SaveResult {
  const { config, diskConfig, projectDir } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  if (!config || !diskConfig) throw configError.loadNotCalled('save');
  const persisted = persistedConfigForSave({
    persisted: diskConfig,
    effective: config,
    updated,
    options,
  });
  try {
    writeConfig(projectDir, persisted);
    store.set((s) => ({ ...s, config: cloneConfig(updated), diskConfig: cloneConfig(persisted) }));
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

function setContextLength(contextLength: number) {
  store.set((s) => {
    if (!s.config) return s;
    if (s.config.implementer.contextLength === contextLength) return s;
    return {
      ...s,
      config: applyRunnerOverrides('implementer', { contextLength }, s.config),
    };
  });
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
  });
}

export const configStore = {
  ...storeBase(store),
  load,
  save,
  useConfig,
  setContextLength,
  setApprovalEnabled,
  __testReset,
};
