import { createStore, storeBase } from '../create-store.js';
import { loadConfig, writeConfig, configPath } from '../../core/config/load/load.js';
import { applyCLIOverrides, applyRunnerOverrides, type CLIOverrides } from '../../core/config/runtime/overrides.js';
import type { Config } from '../../core/schemas/config.js';
import { configError } from '../../core/config/errors.js';
import { warnStderr } from '../../lib/warn.js';
import { deepEqual } from '../../utils/deep-equal.js';
import { isRecord } from '../../utils/type-guards.js';

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

export interface SaveResult {
  ok: boolean;
  error?: Error;
}

export interface SaveOptions {
  changedPaths?: readonly string[] | undefined;
}

function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

type Path = readonly string[];

function parseChangedPaths(paths: readonly string[] | undefined): Path[] {
  return paths
    ?.map(path => path.split('.').filter(Boolean))
    .filter(path => path.length > 0) ?? [];
}

function isPathPrefix(prefix: Path, path: Path): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((part, index) => path[index] === part);
}

function pathIntersectsChangedPath(path: Path, changedPaths: readonly Path[]): boolean {
  return changedPaths.some(changedPath =>
    isPathPrefix(path, changedPath) || isPathPrefix(changedPath, path));
}

function persistedValueForSave(
  persisted: unknown,
  effective: unknown,
  updated: unknown,
  path: Path,
  changedPaths: readonly Path[],
): unknown {
  const equalToEffective = deepEqual(updated, effective);
  if (changedPaths.length === 0) {
    if (equalToEffective) return cloneValue(persisted);
  } else if (equalToEffective && !pathIntersectsChangedPath(path, changedPaths)) {
    return cloneValue(persisted);
  }

  if (!isRecord(updated) || !isRecord(effective)) return cloneValue(updated);

  const next: Record<string, unknown> = {};
  const persistedRecord = isRecord(persisted) ? persisted : {};
  for (const key of Object.keys(updated)) {
    next[key] = persistedValueForSave(persistedRecord[key], effective[key], updated[key], [...path, key], changedPaths);
  }
  return next;
}

function persistedConfigForSave(persisted: Config, effective: Config, updated: Config, options?: SaveOptions): Config {
  const changedPaths = parseChangedPaths(options?.changedPaths);
  if (changedPaths.length > 0 && deepEqual(updated, effective)) {
    const next = cloneConfig(persisted);
    for (const path of changedPaths) {
      const value = path.reduce<unknown>((current, part) =>
        isRecord(current) ? current[part] : undefined, updated);
      if (value !== undefined) {
        setPath(next, path, cloneValue(value));
      }
    }
    return next;
  }
  return persistedValueForSave(persisted, effective, updated, [], changedPaths) as Config;
}

function setPath(target: Config, path: Path, value: unknown): void {
  let current: Record<string, unknown> = target as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!key) return;
    const existing = current[key];
    if (!isRecord(existing)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last) current[last] = value;
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const { config: loaded, warnings } = loadConfig(projectDir);
  for (const w of warnings) warnStderr(`⚠ ${w}`);
  const base = cloneConfig(loaded);
  const config = applyCLIOverrides(base, overrides);
  store.set({ config, diskConfig: cloneConfig(loaded), projectDir, overrides: cloneValue(overrides) });
}

function save(updated: Config, options?: SaveOptions): SaveResult {
  const { config, diskConfig, projectDir } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  if (!config || !diskConfig) throw configError.loadNotCalled('save');
  const persisted = persistedConfigForSave(diskConfig, config, updated, options);
  try {
    writeConfig(projectDir, persisted);
    store.set(s => ({ ...s, config: cloneConfig(updated), diskConfig: cloneConfig(persisted) }));
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
  const state = next ? { ...initial, ...next } : initial;
  store.set({
    ...state,
    config: state.config ? cloneConfig(state.config) : null,
    diskConfig: state.diskConfig ? cloneConfig(state.diskConfig) : state.config ? cloneConfig(state.config) : null,
    overrides: cloneValue(state.overrides),
  });
}

export const configStore = { ...storeBase(store), load, save, useConfig, setContextLength, setApprovalEnabled, __testReset };
