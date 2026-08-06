import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import YAML, { parseDocument, type Document } from 'yaml';
import { CONFIG_VERSION, ConfigSchema, type Config } from '../../schemas/config.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../schemas/runner-fields.js';
import { getKnownProviderBaseURL } from '../../providers/catalog.js';
import { API_PROVIDER_CATALOG } from '../../providers/api-provider-catalog.js';
import { defaultCliAuthChannel } from '../../runners/cli-tool-catalog.js';
import { validateConfig } from './validation/config.js';
import { fromYaml, toYaml } from './transform.js';
import { SPLITBRIEF_DIR, TREES_DIR, CONFIG_FILE, getSplitbriefPath } from '../../paths.js';
import { checkConfigPermissions, ensureGitignore } from '../../../lib/fs.js';
import {
  confinedAtomicWriteFile,
  confinedWriteFile,
  confinedEnsureDir,
  type ConfigRevision,
  type ExpectedConfigRevision,
} from '../../../lib/confined-fs.js';
import { SECURE_FILE_MODE } from '../../../lib/fs.js';
import { assertWritablePathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';

export function configPath(projectDir: string): string {
  return getSplitbriefPath(projectDir, CONFIG_FILE);
}

export function createDefaultConfig(): Config {
  const provider = API_PROVIDER_CATALOG.ollama;
  return {
    version: CONFIG_VERSION,
    planner: {
      kind: 'cli',
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    },
    implementer: {
      kind: 'api',
      provider: provider.id,
      service: provider.service,
      offering: provider.offering,
      model: 'qwen3-coder:30b',
      apiBase: getKnownProviderBaseURL(provider.id),
      temperature: DEFAULT_IMPLEMENTER_TEMPERATURE,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
    },
    workflow: {
      approve: 'default',
      maxRetries: 3,
      git: { commitStrategy: 'none' },
      isolation: 'worktree',
      persistTranscript: true,
      compactionFormat: 'auto',
      mode: 'standard',
      taskReview: 'none',
    },
    theme: 'terminal',
    plannerEstimateReview: false,
    autoSplitOverflow: false,
  };
}

function mergeRunner(
  loaded: Record<string, unknown> | null,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  if (!loaded) return defaults;
  // When kinds differ, the loaded runner is already self-contained. Merging
  // would leak kind-specific fields (e.g. provider/apiBase from an api default
  // into a cli config).
  if (loaded.kind !== undefined && loaded.kind !== defaults.kind) return loaded;
  // When the provider is explicitly set and differs from the default, the
  // provider-specific defaults (model/apiBase) do not apply. Merging them would
  // mask schema validation of the genuinely missing model/apiBase fields.
  if (loaded.provider !== undefined && loaded.provider !== defaults.provider) return loaded;
  return { ...defaults, ...loaded };
}

const MERGE_HANDLED_KEYS = new Set([
  'version',
  'planner',
  'implementer',
  'implementerProfiles',
  'validation',
  'workflow',
  'theme',
  'plannerEstimateReview',
  'autoSplitOverflow',
]);

function mergeWithDefaults(loaded: Record<string, unknown>): Record<string, unknown> {
  const defaults = createDefaultConfig();
  const implementerDefaults: Record<string, unknown> = { ...defaults.implementer };

  const passthrough: Record<string, unknown> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    if (MERGE_HANDLED_KEYS.has(key)) continue;
    if (loaded[key] !== undefined) passthrough[key] = loaded[key];
  }

  return {
    version: CONFIG_VERSION,
    planner: loaded['planner'] ?? defaults.planner,
    implementer: mergeRunner(narrowRecord(loaded['implementer']), implementerDefaults),
    ...(loaded['implementerProfiles'] !== undefined && {
      implementerProfiles: loaded['implementerProfiles'],
    }),
    validation: narrowRecord(loaded['validation'])
      ? { ...defaults.validation, ...narrowRecord(loaded['validation']) }
      : defaults.validation,
    workflow: narrowRecord(loaded['workflow'])
      ? { ...defaults.workflow, ...narrowRecord(loaded['workflow']) }
      : defaults.workflow,
    theme: loaded['theme'] ?? defaults.theme,
    ...passthrough,
    plannerEstimateReview: loaded['plannerEstimateReview'] ?? defaults.plannerEstimateReview,
    autoSplitOverflow: loaded['autoSplitOverflow'] ?? defaults.autoSplitOverflow,
  };
}

export interface LoadConfigResult {
  config: Config;
  warnings: string[];
  loaderDiagnostics: ConfigLoaderDiagnostic[];
  rawYaml: string;
  rawBytes: Uint8Array;
  document: Document.Parsed;
  revision: ExpectedConfigRevision;
}

export type ConfigLoaderDiagnostic = { kind: 'config-file-permissions'; path: string };

export function formatConfigLoaderDiagnostic(diagnostic: ConfigLoaderDiagnostic): string {
  return `Config file ${diagnostic.path} has overly permissive permissions. Consider running: chmod 600 ${diagnostic.path}`;
}

export function dedupeConfigWarnings(warnings: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    unique.push(warning);
  }
  return unique;
}

function combineLoadWarnings(
  loaderDiagnostics: readonly ConfigLoaderDiagnostic[],
  validationWarnings: readonly string[],
): string[] {
  return dedupeConfigWarnings([
    ...loaderDiagnostics.map(formatConfigLoaderDiagnostic),
    ...validationWarnings,
  ]);
}

const CONFIG_RELATIVE_PATH = join(SPLITBRIEF_DIR, CONFIG_FILE);

export type ConfigDocumentSnapshot = Readonly<{
  rawBytes: Uint8Array;
  rawYaml: string;
  document: Document.Parsed;
  revision: ExpectedConfigRevision;
}>;

export type ConfigDocumentTransactionResult =
  | Readonly<{ kind: 'saved'; revision: ConfigRevision }>
  | Readonly<{ kind: 'conflict'; currentRevision: ExpectedConfigRevision }>
  | Readonly<{
      kind: 'durability-uncertain';
      observedRevision: ConfigRevision;
      warning: string;
    }>;

type ConfigDocumentAtomicWriter = typeof confinedAtomicWriteFile;

const configTransactions = new Map<string, Promise<void>>();
const DURABILITY_WARNING =
  'Config replacement is visible, but directory durability could not be confirmed.';

export function ensureConfigGitignore(projectDir: string): void {
  ensureGitignore(projectDir, `${SPLITBRIEF_DIR}/`);
  ensureGitignore(projectDir, `${TREES_DIR}/`);
}

function configRevision(rawBytes: Uint8Array, stat: BigIntStats): ConfigRevision {
  return {
    rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

export function configRevisionsMatch(
  expected: ExpectedConfigRevision,
  observed: ExpectedConfigRevision,
): boolean {
  if (expected === null || observed === null) return expected === observed;
  return (
    expected.rawSha256 === observed.rawSha256 &&
    expected.fileIdentity.dev === observed.fileIdentity.dev &&
    expected.fileIdentity.ino === observed.fileIdentity.ino &&
    expected.fileIdentity.size === observed.fileIdentity.size &&
    expected.fileIdentity.mtimeNs === observed.fileIdentity.mtimeNs
  );
}

function canonicalConfigTarget(projectDir: string): string | null {
  assertWritablePathConfined(CONFIG_RELATIVE_PATH, projectDir);
  const parent = join(realpathSync(projectDir), SPLITBRIEF_DIR);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  if (realParent !== parent) throw pathConfinementError.symlinkParent(parent);
  return join(parent, CONFIG_FILE);
}

function emptyConfigDocumentSnapshot(): ConfigDocumentSnapshot {
  return {
    rawBytes: new Uint8Array(),
    rawYaml: '',
    document: parseDocument(''),
    revision: null,
  };
}

export function readConfigDocument(projectDir: string): ConfigDocumentSnapshot {
  const displayPath = configPath(projectDir);
  const filePath = canonicalConfigTarget(projectDir);
  if (filePath === null) return emptyConfigDocumentSnapshot();

  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return emptyConfigDocumentSnapshot();
    if (isNodeError(err) && err.code === 'ELOOP')
      throw pathConfinementError.symlinkRead(displayPath);
    throw configError.unreadable(displayPath);
  }

  try {
    const openedStat = fstatSync(descriptor, { bigint: true });
    if (!openedStat.isFile()) throw configError.unreadable(displayPath);
    const rawBytes = readFileSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    const rawYaml = rawBytes.toString('utf8');
    return {
      rawBytes,
      rawYaml,
      document: parseDocument(rawYaml),
      revision: configRevision(rawBytes, stat),
    };
  } finally {
    closeSync(descriptor);
  }
}

function parseLoadedConfig(
  projectDir: string,
  snapshot: ConfigDocumentSnapshot,
): Omit<LoadConfigResult, keyof ConfigDocumentSnapshot> {
  const filePath = configPath(projectDir);
  const loaderDiagnostics: ConfigLoaderDiagnostic[] = [];
  if (process.platform !== 'win32' && !checkConfigPermissions(filePath)) {
    loaderDiagnostics.push({ kind: 'config-file-permissions', path: filePath });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(snapshot.rawYaml);
  } catch (err) {
    throw configError.invalidYaml(filePath, err);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError.validationFailed(filePath, [
      `Configuration in ${SPLITBRIEF_DIR}/${CONFIG_FILE} must be a YAML object.`,
    ]);
  }

  const camelRecord = narrowRecord(fromYaml(parsed));
  if (!camelRecord) throw configError.notAnObject('Config');
  if (camelRecord['version'] !== CONFIG_VERSION) {
    throw configError.unsupportedVersion(camelRecord['version']);
  }

  const {
    errors,
    warnings: validationWarnings,
    data,
  } = validateConfig(mergeWithDefaults(camelRecord));
  if (errors.length > 0) {
    const lines = [`Configuration errors in ${SPLITBRIEF_DIR}/${CONFIG_FILE}:`];
    for (const err of errors) lines.push(`  ${err.path}: ${err.message}`);
    throw configError.validationFailed(
      filePath,
      lines,
      errors.flatMap((err) => err.diagnosticState ?? []),
    );
  }
  if (!data) {
    throw configError.validationFailed(filePath, [
      'Unexpected validation state: no data after successful validation',
    ]);
  }
  return {
    config: data,
    loaderDiagnostics,
    warnings: combineLoadWarnings(loaderDiagnostics, validationWarnings),
  };
}

export function loadConfig(projectDir: string): LoadConfigResult {
  const snapshot = readConfigDocument(projectDir);
  if (snapshot.revision === null) {
    return {
      config: createDefaultConfig(),
      warnings: [],
      loaderDiagnostics: [],
      ...snapshot,
    };
  }
  return { ...parseLoadedConfig(projectDir, snapshot), ...snapshot };
}

export function writeConfig(projectDir: string, config: Config): string {
  const text = YAML.stringify(toYaml(config));
  ensureConfigGitignore(projectDir);
  confinedEnsureDir(projectDir, SPLITBRIEF_DIR);
  confinedWriteFile(projectDir, CONFIG_RELATIVE_PATH, text);
  return text;
}

export interface ConfigDocumentEdit {
  path: readonly string[];
  value: unknown;
}

export function renderConfigDocumentEdits(
  snapshot: ConfigDocumentSnapshot,
  edits: readonly ConfigDocumentEdit[],
): string {
  let document = snapshot.document.clone();
  for (const { path, value } of edits) {
    if (path.length === 0) {
      document = parseDocument(value === undefined ? '' : YAML.stringify(value));
    } else if (value === undefined) {
      document.deleteIn(path);
    } else {
      document.setIn(path, value);
    }
  }
  return document.toString();
}

async function serializedConfigTransaction<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = configTransactions.get(path) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const queued = prior.then(
    () => turn,
    () => turn,
  );
  configTransactions.set(path, queued);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (configTransactions.get(path) === queued) configTransactions.delete(path);
  }
}

async function transactConfigDocumentWithWriter(
  projectDir: string,
  expectedRevision: ExpectedConfigRevision,
  edits: readonly ConfigDocumentEdit[],
  atomicWrite: ConfigDocumentAtomicWriter,
  allowRootReplacement: boolean,
): Promise<ConfigDocumentTransactionResult> {
  const transactionPath =
    canonicalConfigTarget(projectDir) ?? join(realpathSync(projectDir), CONFIG_RELATIVE_PATH);
  return serializedConfigTransaction(transactionPath, async () => {
    const snapshot = readConfigDocument(projectDir);
    if (!configRevisionsMatch(expectedRevision, snapshot.revision)) {
      return { kind: 'conflict', currentRevision: snapshot.revision };
    }
    if (edits.length === 0 && snapshot.revision !== null) {
      return { kind: 'saved', revision: snapshot.revision };
    }
    if (
      expectedRevision !== null &&
      !allowRootReplacement &&
      edits.some((edit) => edit.path.length === 0)
    ) {
      throw configError.validationFailed(configPath(projectDir), [
        'Root config replacement is reserved for explicit force initialization.',
      ]);
    }

    const rawYaml = renderConfigDocumentEdits(snapshot, edits);
    const intendedSnapshot: ConfigDocumentSnapshot = {
      rawBytes: Buffer.from(rawYaml),
      rawYaml,
      document: parseDocument(rawYaml),
      revision: snapshot.revision,
    };
    parseLoadedConfig(projectDir, intendedSnapshot);
    ensureConfigGitignore(projectDir);
    confinedEnsureDir(projectDir, SPLITBRIEF_DIR);

    const targetPath = canonicalConfigTarget(projectDir);
    if (targetPath === null) throw configError.unreadable(configPath(projectDir));
    const result = await atomicWrite(targetPath, intendedSnapshot.rawBytes, {
      expectedRevision,
      mode: SECURE_FILE_MODE,
    });
    if (result.kind === 'conflict') {
      const current = readConfigDocument(projectDir);
      return { kind: 'conflict', currentRevision: current.revision };
    }
    if (result.kind === 'written') return { kind: 'saved', revision: result.revision };

    const actual = readConfigDocument(projectDir);
    if (actual.revision === null) throw configError.unreadable(configPath(projectDir));
    parseLoadedConfig(projectDir, actual);
    return {
      kind: 'durability-uncertain',
      observedRevision: actual.revision,
      warning: DURABILITY_WARNING,
    };
  });
}

export async function transactConfigDocument(
  projectDir: string,
  expectedRevision: ExpectedConfigRevision,
  edits: readonly ConfigDocumentEdit[],
): Promise<ConfigDocumentTransactionResult> {
  return transactConfigDocumentWithWriter(
    projectDir,
    expectedRevision,
    edits,
    confinedAtomicWriteFile,
    false,
  );
}

export async function transactConfigDocumentForTest(
  projectDir: string,
  expectedRevision: ExpectedConfigRevision,
  edits: readonly ConfigDocumentEdit[],
  atomicWrite: ConfigDocumentAtomicWriter,
): Promise<ConfigDocumentTransactionResult> {
  return transactConfigDocumentWithWriter(projectDir, expectedRevision, edits, atomicWrite, false);
}

export function writeConfigDocument(
  projectDir: string,
  rawYaml: string,
  edits: readonly ConfigDocumentEdit[],
): string {
  const doc = parseDocument(rawYaml);
  for (const { path, value } of edits) {
    if (path.length === 0) continue;
    if (value === undefined) {
      doc.deleteIn(path);
    } else {
      doc.setIn(path, value);
    }
  }
  const text = doc.toString();
  ensureConfigGitignore(projectDir);
  confinedEnsureDir(projectDir, SPLITBRIEF_DIR);
  confinedWriteFile(projectDir, CONFIG_RELATIVE_PATH, text);
  return text;
}

export async function initConfig(
  projectDir: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const snapshot = readConfigDocument(projectDir);
  if (!opts.force && snapshot.revision !== null) return;
  const result = await transactConfigDocumentWithWriter(
    projectDir,
    snapshot.revision,
    [{ path: [], value: toYaml(createDefaultConfig()) }],
    confinedAtomicWriteFile,
    true,
  );
  if (result.kind !== 'saved') {
    const path = configPath(projectDir);
    const cause = configError.validationFailed(path, [
      `Config initialization did not complete: ${result.kind}.`,
    ]);
    throw configError.saveFailed(path, cause);
  }
}
