import { createStore, storeBase } from '../create-store.js';
import { loadConfig, writeConfig, configPath } from '../../core/config/load/load.js';
import { applyCLIOverrides, applyRunnerOverrides, type CLIOverrides } from '../../core/config/runtime/overrides.js';
import type { Config } from '../../core/schemas/config.js';
import { configError } from '../../core/config/errors.js';
import { warnStderr } from '../../lib/warn.js';

interface ConfigState {
  config: Config | null;
  projectDir: string;
  overrides: CLIOverrides;
}

const initial: ConfigState = {
  config: null,
  projectDir: '',
  overrides: {},
};

const store = createStore<ConfigState>(initial);

export interface SaveResult {
  ok: boolean;
  error?: Error;
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const { config: loaded, warnings } = loadConfig(projectDir);
  for (const w of warnings) warnStderr(`⚠ ${w}`);
  const base = structuredClone(loaded);
  const config = applyCLIOverrides(base, overrides);
  store.set({ config, projectDir, overrides });
}

function save(updated: Config): SaveResult {
  const { projectDir } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  try {
    writeConfig(projectDir, updated);
    store.set(s => ({ ...s, config: updated }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: configError.saveFailed(configPath(projectDir), err) };
  }
}

function useConfig(): Config {
  const config = store.use(s => s.config);
  if (!config) throw configError.loadNotCalled('rendering');
  return config;
}

function setContextLength(contextLength: number) {
  store.set(s => {
    if (!s.config) return s;
    if (s.config.implementer.contextLength === contextLength) return s;
    return {
      ...s,
      config: applyRunnerOverrides('implementer', { contextLength }, s.config),
    };
  });
}

function setApprovalEnabled(enabled: boolean) {
  store.set(s => {
    if (!s.config) return s;
    const currentEnabled = s.config.approval?.enabled !== false;
    if (currentEnabled === enabled) return s;
    const base = s.config.approval ?? { enabled: true, feedRejectionsToPlanner: true };
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
  store.set(next ? { ...initial, ...next } : initial);
}

export const configStore = { ...storeBase(store), load, save, useConfig, setContextLength, setApprovalEnabled, __testReset };
