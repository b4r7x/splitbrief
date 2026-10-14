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
import YAML, { isMap, isScalar, parseDocument, type Document } from 'yaml';
import { SPLITBRIEF_DIR, CONFIG_FILE, getSplitbriefPath } from '../../paths.js';
import { ensureGitignore } from '../../../lib/fs.js';
import { checkIgnoredPaths } from '../../../lib/git/files.js';
import type { ConfigRevision, ExpectedConfigRevision } from '../../../lib/confined-fs-atomic.js';
import { assertWritablePathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { configError } from '../errors.js';
import { loadedKey } from './transform.js';

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

/**
 * A rule git already applies — a parent `.gitignore`, `.git/info/exclude`, the global excludes
 * file, or a spelling the text check does not know — leaves a clean checkout clean. The config
 * file is asked apart from the directory: a rule that ignores only the subdirectories of an
 * existing `.splitbrief/` matches the directory probe and still leaves the config file reported.
 */
export async function ensureConfigGitignore(projectDir: string): Promise<void> {
  const entry = `${SPLITBRIEF_DIR}/`;
  const probes = [entry, CONFIG_RELATIVE_PATH];
  if ((await checkIgnoredPaths(projectDir, probes)).length === probes.length) return;
  ensureGitignore(projectDir, entry);
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

/** The keys of a map the loader reads as `id`, in document order. */
function spellingsOf(node: unknown, id: string, loadedPath: readonly string[]): string[] {
  if (!isMap(node)) return [];
  const keys: string[] = [];
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key === 'string' && loadedKey(key, loadedPath) === id) keys.push(key);
  }
  return keys;
}

/**
 * An edit is addressed in the writer's spelling, `output_format`, and the file may spell the key
 * `outputFormat`: a delete aimed at the one leaves the other standing. Each segment resolves to the
 * key the loader reads, in the file's own spelling; where the file carries both spellings the
 * loader reads the later, so that one is edited and the earlier twins are named for removal. A key
 * the file does not carry yet takes the writer's spelling.
 */
function resolveEditPath(
  document: Document,
  path: readonly string[],
): Readonly<{ target: string[]; twins: string[][] }> {
  const target: string[] = [];
  const twins: string[][] = [];
  const loadedPath: string[] = [];
  let node: unknown = document.contents;
  for (const segment of path) {
    const id = loadedKey(segment, loadedPath);
    const spellings = spellingsOf(node, id, loadedPath);
    const key = spellings.at(-1) ?? segment;
    for (const twin of spellings.slice(0, -1)) twins.push([...target, twin]);
    target.push(key);
    loadedPath.push(id);
    node = isMap(node) ? node.get(key, true) : undefined;
  }
  return { target, twins };
}

/** Applies keyed edits in place; a root replacement is the caller's to make. */
export function applyConfigDocumentEdits(
  document: Document,
  edits: readonly ConfigDocumentEdit[],
): void {
  for (const { path, value } of edits) {
    if (path.length === 0) continue;
    const { target, twins } = resolveEditPath(document, path);
    for (const twin of twins) document.deleteIn(twin);
    if (value === undefined) document.deleteIn(target);
    else document.setIn(target, value);
  }
}

export function renderConfigDocumentEdits(
  snapshot: ConfigDocumentSnapshot,
  edits: readonly ConfigDocumentEdit[],
): string {
  let document = snapshot.document.clone();
  for (const edit of edits) {
    if (edit.path.length === 0) {
      document = parseDocument(edit.value === undefined ? '' : YAML.stringify(edit.value));
    } else {
      applyConfigDocumentEdits(document, [edit]);
    }
  }
  return document.toString();
}
