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
import { SPLITBRIEF_DIR, TREES_DIR, CONFIG_FILE, getSplitbriefPath } from '../../paths.js';
import { ensureGitignore } from '../../../lib/fs.js';
import type { ConfigRevision, ExpectedConfigRevision } from '../../../lib/confined-fs-atomic.js';
import { assertWritablePathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { configError } from '../errors.js';

export const CONFIG_RELATIVE_PATH = join(SPLITBRIEF_DIR, CONFIG_FILE);

export function configPath(projectDir: string): string {
  return getSplitbriefPath(projectDir, CONFIG_FILE);
}

export type ConfigDocumentSnapshot = Readonly<{
  rawBytes: Uint8Array;
  rawYaml: string;
  document: Document.Parsed;
  revision: ExpectedConfigRevision;
}>;

export interface ConfigDocumentEdit {
  path: readonly string[];
  value: unknown;
}

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

export function canonicalConfigTarget(projectDir: string): string | null {
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
