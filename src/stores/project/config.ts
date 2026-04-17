import { createStore, storeBase } from '../create-store.js';
import { loadConfig, writeConfig, applyCLIOverrides, applyRunnerOverrides } from '../../core/config/index.js';
import type { CLIOverrides } from '../../core/config/index.js';
import type { Config } from '../../types.js';

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
  const base = structuredClone(loadConfig(projectDir));
  const config = applyCLIOverrides(base, overrides);
  store.set({ config, projectDir, overrides });
}

function save(updated: Config): SaveResult {
  const { projectDir } = store.get();
  if (!projectDir) throw new Error('configStore.load must be called before save');
  try {
    writeConfig(projectDir, updated);
    store.set(s => ({ ...s, config: updated }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function useConfig(): Config {
  const config = store.use(s => s.config);
  if (!config) throw new Error('configStore.load must be called before rendering');
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

export const configStore = { ...storeBase(store), set: store.set, load, save, useConfig, setContextLength };
