import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import YAML, { parseDocument, type Document } from 'yaml';
import { CONFIG_VERSION, type Config } from '../../schemas/config.js';
import { validateConfig } from './validation/config.js';
import { fromYaml, toYaml } from './transform.js';
import { createDefaultConfig, mergeWithDefaults } from './defaults.js';
import {
  CONFIG_RELATIVE_PATH,
  canonicalConfigTarget,
  configPath,
  configRevisionsMatch,
  ensureConfigGitignore,
  readConfigDocument,
  renderConfigDocumentEdits,
  type ConfigDocumentEdit,
  type ConfigDocumentSnapshot,
} from './document.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../paths.js';
import { checkConfigPermissions } from '../../../lib/fs.js';
import { confinedWriteFile, confinedEnsureDir } from '../../../lib/confined-fs.js';
import {
  confinedAtomicWriteFile,
  type ConfigRevision,
  type ExpectedConfigRevision,
} from '../../../lib/confined-fs-atomic.js';
import { SECURE_FILE_MODE } from '../../../lib/fs.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { configError } from '../errors.js';

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
