import { createStore, storeBase } from '../create-store.js';
import {
  loadConfig,
  transactConfigDocument,
  configRevisionsMatch,
  configPath,
} from '../../core/config/load/io.js';
import type { ConfigRevision, ExpectedConfigRevision } from '../../lib/confined-fs-atomic.js';
import { toYaml } from '../../core/config/load/transform.js';
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
  revision: ExpectedConfigRevision;
  projectDir: string;
  overrides: CLIOverrides;
  detectedContextLength: number | undefined;
}

const initial: ConfigState = {
  config: null,
  diskConfig: null,
  rawYaml: '',
  revision: null,
  projectDir: '',
  overrides: {},
  detectedContextLength: undefined,
};

const store = createStore<ConfigState>(initial);

export type ConfigSaveResult =
  | Readonly<{ kind: 'saved'; ok: true; revision: ConfigRevision }>
  | Readonly<{
      kind: 'conflict';
      ok: false;
      currentRevision: ExpectedConfigRevision;
    }>
  | Readonly<{
      kind: 'durability-uncertain';
      ok: false;
      observedRevision: ConfigRevision;
      warning: string;
    }>
  | Readonly<{ kind: 'failure'; ok: false; error: Error }>;

let saveQueue: Promise<void> = Promise.resolve();

function loadedState(projectDir: string, overrides: CLIOverrides): ConfigState {
  const { config: loaded, loaderDiagnostics, rawYaml, revision } = loadConfig(projectDir);
  const base = cloneConfig(loaded);
  const { config, warnings } = resolveEffectiveConfig({
    base,
    overrides,
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  return {
    config,
    diskConfig: cloneConfig(loaded),
    rawYaml,
    revision,
    projectDir,
    overrides: cloneValue(overrides),
    detectedContextLength: undefined,
  };
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  store.set(loadedState(projectDir, overrides));
}

async function saveOnce(
  updated: Config,
  expectedRevision: ExpectedConfigRevision,
  expectedProjectDir: string,
): Promise<ConfigSaveResult> {
  const { config, diskConfig, projectDir, overrides, revision } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  if (!config || !diskConfig) throw configError.loadNotCalled('save');
  if (projectDir !== expectedProjectDir || !configRevisionsMatch(expectedRevision, revision)) {
    return { kind: 'conflict', ok: false, currentRevision: revision };
  }
  const persisted = persistedConfigForSave({
    persisted: diskConfig,
    effective: config,
    updated,
  });
  const edits =
    revision === null
      ? [{ path: [], value: toYaml(persisted) }]
      : editsForSave(diskConfig, persisted);
  try {
    const result = await transactConfigDocument(projectDir, revision, edits);
    if (result.kind === 'conflict') {
      return {
        kind: 'conflict',
        ok: false,
        currentRevision: result.currentRevision,
      };
    }
    const next = loadedState(projectDir, overrides);
    if (result.kind === 'saved') {
      if (!configRevisionsMatch(result.revision, next.revision)) {
        return { kind: 'conflict', ok: false, currentRevision: next.revision };
      }
      store.set((state) => ({
        ...state,
        config: cloneConfig(updated),
        diskConfig: cloneConfig(persisted),
        rawYaml: next.rawYaml,
        revision: next.revision,
      }));
      return { kind: 'saved', ok: true, revision: result.revision };
    }
    store.set(next);
    return { ...result, ok: false };
  } catch (err) {
    return {
      kind: 'failure',
      ok: false,
      error: configError.saveFailed(configPath(projectDir), err),
    };
  }
}

function save(updated: Config): Promise<ConfigSaveResult> {
  const { projectDir, revision } = store.get();
  if (!projectDir) throw configError.loadNotCalled('save');
  const operation = saveQueue.then(() => saveOnce(updated, revision, projectDir));
  saveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
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
  saveQueue = Promise.resolve();
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
