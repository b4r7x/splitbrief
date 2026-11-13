import { createStore, storeBase } from '../create-store.js';
import { loadConfig, transactConfigDocument } from '../../core/config/load/io.js';
import {
  configRevisionsMatch,
  configPath,
  readConfigDocument,
} from '../../core/config/load/document.js';
import type { ConfigRevision, ExpectedConfigRevision } from '../../lib/confined-fs-atomic.js';
import { toYaml } from '../../core/config/load/transform.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides/schema.js';
import {
  type EffectiveConfigWarning,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import { configError } from '../../core/config/errors.js';
import { SOFT_SEP } from '../../core/separators.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { feedbackStore } from '../ui/feedback.js';
import { configErrorLines } from './save-feedback.js';
import { selectInitialCrew } from '../../core/crew/default.js';
import { type SeatIds, sameSeatIds, seatIdsOf } from '../../core/crew/identity.js';
import {
  cloneConfig,
  cloneValue,
  persistedConfigForSave,
  editsForSave,
} from './config-persistence.js';

interface ConfigState {
  config: Config | null;
  /** The loader diagnostics and the ignored flags of `config`; a run start reports them. */
  configWarnings: readonly EffectiveConfigWarning[];
  diskConfig: Config | null;
  rawYaml: string;
  revision: ExpectedConfigRevision;
  projectDir: string;
  overrides: CLIOverrides;
  detectedContextLength: number | undefined;
  discovery: Discovery | undefined;
  /** The line that named a hand edit that did not load; a load clears it. */
  refusedEdit: string | undefined;
}

/** The context window boot discovery found, and the implementer it measured. */
type Discovery = Readonly<{ contextLength: number; seat: SeatIds }>;

const initial: ConfigState = {
  config: null,
  configWarnings: [],
  diskConfig: null,
  rawYaml: '',
  revision: null,
  projectDir: '',
  overrides: {},
  detectedContextLength: undefined,
  discovery: undefined,
  refusedEdit: undefined,
};

const store = createStore<ConfigState>(initial);

export type ConfigSaveResult =
  | Readonly<{ kind: 'saved'; ok: true; revision: ConfigRevision; ignoreRuleAdded: boolean }>
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

function loadedState(
  projectDir: string,
  overrides: CLIOverrides,
  discovery: Discovery | undefined,
): ConfigState {
  const { config: loaded, loaderDiagnostics, rawYaml, revision } = loadConfig(projectDir);
  const base = cloneConfig(loaded);
  const { config, warnings } = resolveEffectiveConfig({
    base,
    overrides,
    loaderDiagnostics,
  });
  return withDiscovery({
    config,
    configWarnings: warnings,
    diskConfig: cloneConfig(
      revision === null ? selectInitialCrew({ detected: null, overrides }).persisted : loaded,
    ),
    rawYaml,
    revision,
    projectDir,
    overrides: cloneValue(overrides),
    detectedContextLength: undefined,
    discovery,
    refusedEdit: undefined,
  });
}

function load(projectDir: string, overrides: CLIOverrides = {}) {
  store.set(loadedState(projectDir, overrides, undefined));
}

function defaultImplementer(config: Config): ImplementerConfig {
  return resolveImplementerProfiles(config).defaultProfile.config;
}

/** A context window belongs to the tool and the model; the effort does not change it. */
function windowSeat(config: Config): SeatIds {
  return { ...seatIdsOf(defaultImplementer(config)), axes: [] };
}

/**
 * Puts the discovered context window into a state whose config was just replaced, as a restart
 * would. A measured window is only the detected window of the implementer it measured, while the
 * file names no Prompt budget; it never becomes a Prompt budget. On another implementer the
 * measured window goes.
 */
function withDiscovery(state: ConfigState): ConfigState {
  const { config, diskConfig, discovery } = state;
  const cleared = { ...state, detectedContextLength: undefined };
  if (config === null || discovery === undefined) return cleared;
  const named = diskConfig !== null && defaultImplementer(diskConfig).contextLength !== undefined;
  if (named || !sameSeatIds(discovery.seat, windowSeat(config))) return cleared;
  return { ...state, detectedContextLength: discovery.contextLength };
}

/** Loads the file again when it is not the file the store read: a hand edit while SPLITBRIEF is open. */
function reloadIfChanged(): void {
  const { projectDir, overrides, revision, discovery } = store.get();
  if (!projectDir) throw configError.loadNotCalled('reload');
  if (configRevisionsMatch(revision, readConfigDocument(projectDir).revision)) return;
  store.set(loadedState(projectDir, overrides, discovery));
}

/**
 * The reload of a surface that shows the config: home on its refresh tick, Settings and the seat
 * picker when they open. An edit that does not load is named once, what SPLITBRIEF keeps first, so
 * a cut line loses the end of the reason; the store keeps the config it loaded before.
 */
function reloadShownConfig(): void {
  try {
    reloadIfChanged();
  } catch (err) {
    const { intro, issues } = configErrorLines(err instanceof Error ? err.message : String(err));
    const reason = [intro, issues.join('; ')].filter((part) => part !== '').join(' ');
    const message = toErrorMessage(
      `SPLITBRIEF keeps the config it loaded before${SOFT_SEP}${reason}`,
    );
    if (store.get().refusedEdit === message) return;
    store.set((state) => ({ ...state, refusedEdit: message }));
    feedbackStore.setError(message);
  }
}

function refreshFromExecution(projectDir: string, config: Config): void {
  const { config: diskConfig, rawYaml, revision } = loadConfig(projectDir);
  store.set((state) =>
    withDiscovery({
      ...state,
      projectDir,
      config: cloneConfig(config),
      diskConfig: cloneConfig(diskConfig),
      rawYaml,
      revision,
    }),
  );
}

async function saveOnce(
  updated: Config,
  expectedRevision: ExpectedConfigRevision,
  expectedProjectDir: string,
): Promise<ConfigSaveResult> {
  const {
    config,
    configWarnings,
    diskConfig,
    projectDir,
    overrides,
    revision,
    rawYaml,
    discovery,
  } = store.get();
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
      : editsForSave(diskConfig, persisted, rawYaml);
  try {
    const result = await transactConfigDocument(projectDir, revision, edits);
    if (result.kind === 'conflict') {
      reloadIfChanged();
      return {
        kind: 'conflict',
        ok: false,
        currentRevision: result.currentRevision,
      };
    }
    const next = {
      ...loadedState(projectDir, revision === null ? {} : overrides, discovery),
      ...(revision === null && {
        config: cloneConfig(updated),
        configWarnings,
        overrides: cloneValue(overrides),
      }),
    };
    if (result.kind === 'saved') {
      if (!configRevisionsMatch(result.revision, next.revision)) {
        reloadIfChanged();
        return { kind: 'conflict', ok: false, currentRevision: next.revision };
      }
      store.set((state) =>
        withDiscovery({
          ...state,
          config: cloneConfig(updated),
          configWarnings: next.configWarnings,
          diskConfig: cloneConfig(persisted),
          rawYaml: next.rawYaml,
          revision: next.revision,
        }),
      );
      return {
        kind: 'saved',
        ok: true,
        revision: result.revision,
        ignoreRuleAdded: result.ignoreRuleAdded,
      };
    }
    store.set(withDiscovery(next));
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

function setInitialCrew(config: Config): void {
  store.set((state) => {
    if (state.revision !== null) return state;
    const { persisted, effective } = selectInitialCrew({
      detected: config,
      overrides: state.overrides,
    });
    return withDiscovery({
      ...state,
      config: cloneConfig(effective),
      diskConfig: cloneConfig(persisted),
    });
  });
}

function setDetectedContextLength(contextLength: number) {
  store.set((s) =>
    s.config === null
      ? s
      : withDiscovery({ ...s, discovery: { contextLength, seat: windowSeat(s.config) } }),
  );
}

function getDetectedContextLength(): number | undefined {
  return store.get().detectedContextLength;
}

/** Whether `config` builds on the loaded build seat, so a window read for it fits that seat. */
function buildsOnLoadedSeat(config: Config): boolean {
  const loaded = store.get().config;
  return loaded !== null && sameSeatIds(windowSeat(config), windowSeat(loaded));
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
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

/**
 * REVIEW None in the config the next pass of a run starts on: the window's crew, which an open
 * run continues with. A store with no project config loaded names no REVIEW None.
 */
function reviewNone(): boolean {
  const { config } = store.get();
  return config !== null && resolveReviewCadence(config) === 'none';
}

export const configStore = {
  ...storeBase(store),
  load,
  reviewNone,
  reloadIfChanged,
  reloadShownConfig,
  refreshFromExecution,
  save,
  useConfig,
  setInitialCrew,
  setDetectedContextLength,
  getDetectedContextLength,
  buildsOnLoadedSeat,
  __testReset,
};
