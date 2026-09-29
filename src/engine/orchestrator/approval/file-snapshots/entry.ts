import {
  chmod,
  link,
  lstat,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureSecureDir, fsError } from '../../../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertProjectWritablePathConfined,
  CONTROL_PLANE_SEGMENTS,
  pathConfinementError,
} from '../../../../lib/path-confinement.js';
import { isENOENT } from '../../../../lib/process/errors.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { collectTrackedFiles } from '../../../snapshots/files.js';
import { warnError } from '../../../../lib/warn.js';

/** In-memory snapshot value for one entry; never serialized to JSON. */
export type FileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'file'; bytes: Buffer; sha256: string; mode: number };

type ConfinedFileEntry = Extract<FileSnapshotEntry, { kind: 'file' }>;

function assertRegularEntry(fullPath: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('snapshot entry', fullPath, 'must be a regular file');
  }
}

/** The confined entry's own stat, never through a final symlink; null only for ENOENT. */
async function lstatConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<{ fullPath: string; stat: Stats } | null> {
  assertPathConfined(relativePath, projectDir);
  const fullPath = resolve(projectDir, relativePath);
  try {
    return { fullPath, stat: await lstat(fullPath) };
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

/** Resolves the confined entry; null only for ENOENT, unsafe shapes throw. */
async function observeConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<{ path: string; mode: number } | null> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry === null) return null;
  const { fullPath, stat } = entry;
  if (stat.isSymbolicLink()) throw pathConfinementError.symlinkRead(fullPath);
  assertRegularEntry(fullPath, stat);
  // The final component is a regular file; the realpath walk still rejects a
  // symlinked parent directory that escapes the project root.
  assertExistingPathConfined(relativePath, projectDir);
  return { path: fullPath, mode: stat.mode & 0o777 };
}

export async function readConfinedEntry(
  projectDir: string,
  relativePath: string,
): Promise<FileSnapshotEntry> {
  const observed = await observeConfinedEntry(projectDir, relativePath);
  if (observed === null) return { kind: 'absent' };
  const bytes = await readFile(observed.path);
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: observed.mode };
}

// Where the kernel lands `path`: the real path of its deepest existing
// ancestor, then the names below it that do not exist yet.
async function kernelLanding(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
    return join(await kernelLanding(dirname(path)), basename(path));
  }
}

/**
 * The target of a symlink that stays inside the project: a relative target that
 * climbs only in one leading run of `..` that stays inside the root, then names,
 * so it names the same place in the worktree and the staged copy; and that the
 * kernel lands inside the root and outside the control plane, following every
 * link on the way, dangling or not.
 * Null for any other entry; the entry reads above refuse those links.
 */
export async function readProjectSymlink(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry === null || !entry.stat.isSymbolicLink()) return null;
  const { fullPath } = entry;
  const target = await readlink(fullPath);
  if (isAbsolute(target)) return null;
  // The kernel resolves a name before the `..` after it, so a `..` behind a
  // symlinked name climbs from wherever that link points. A climb above the root
  // that comes back down through the root's own name reads as inside here, yet
  // names another place in the worktree.
  const linkDir = relative(projectDir, dirname(fullPath));
  let depth = linkDir === '' ? 0 : linkDir.split(sep).length;
  let named = false;
  for (const segment of target.split('/')) {
    if (segment === '..') {
      depth -= 1;
      if (named || depth < 0) return null;
    } else if (segment !== '' && segment !== '.') {
      named = true;
    }
  }
  let landing: string;
  try {
    landing = relative(
      await realpath(projectDir),
      await kernelLanding(`${dirname(fullPath)}${sep}${target}`),
    );
  } catch {
    // A loop, or a file or an unreadable directory on the way: it lands nowhere.
    return null;
  }
  // A link into `.git` or `.splitbrief` gives the control plane a second name.
  const first = landing.split(sep)[0] ?? '';
  return first !== '..' && !CONTROL_PLANE_SEGMENTS.has(first) ? target : null;
}

/** What one target file looked like at acquisition; contents are never kept. */
export type FileEntryFingerprint = { sha256: string; mode: number };

/**
 * Every supported project file of the target, fingerprinted before a worker saw
 * its workspace. The map is complete over that set, so a path it does not carry
 * was absent from the target at acquisition.
 */
export type AcquisitionBaseline = ReadonlyMap<string, FileEntryFingerprint>;

export async function captureAcquisitionBaseline(projectDir: string): Promise<AcquisitionBaseline> {
  const baseline = new Map<string, FileEntryFingerprint>();
  for (const file of await collectTrackedFiles(projectDir)) {
    const entry = await readConfinedEntry(projectDir, file);
    if (entry.kind === 'file') baseline.set(file, { sha256: entry.sha256, mode: entry.mode });
  }
  return baseline;
}

export async function matchesAcquisitionBaseline(
  projectDir: string,
  file: string,
  baseline: AcquisitionBaseline,
): Promise<boolean> {
  // The baseline fingerprints regular files only, so a symlink never matches it.
  if ((await lstatConfinedEntry(projectDir, file))?.stat.isSymbolicLink()) return false;
  const current = await readConfinedEntry(projectDir, file);
  const fingerprint = baseline.get(file);
  if (fingerprint === undefined) return current.kind === 'absent';
  return (
    current.kind === 'file' &&
    current.sha256 === fingerprint.sha256 &&
    (current.mode & 0o777) === (fingerprint.mode & 0o777)
  );
}

export function sameFileEntry(a: FileSnapshotEntry, b: FileSnapshotEntry): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.sha256 === b.sha256 && (a.mode & 0o777) === (b.mode & 0o777);
}

/**
 * Both trees hold the same entry at `relativePath`: the same project symlink,
 * the same file bytes and mode, or nothing. Any other symlink matches nothing
 * and is never read through.
 */
export async function entriesMatch(
  leftDir: string,
  rightDir: string,
  relativePath: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    lstatConfinedEntry(leftDir, relativePath),
    lstatConfinedEntry(rightDir, relativePath),
  ]);
  if (left?.stat.isSymbolicLink() || right?.stat.isSymbolicLink()) {
    const target = await readProjectSymlink(leftDir, relativePath);
    return target !== null && target === (await readProjectSymlink(rightDir, relativePath));
  }
  return sameFileEntry(
    await readConfinedEntry(leftDir, relativePath),
    await readConfinedEntry(rightDir, relativePath),
  );
}

export async function writeConfinedEntry(
  projectDir: string,
  relativePath: string,
  entry: FileSnapshotEntry,
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  if (entry.kind === 'absent') {
    const observed = await observeConfinedEntry(projectDir, relativePath);
    await beforeWrite?.();
    if (observed !== null) await rm(observed.path, { force: true });
    return;
  }
  await writeConfinedFileEntry(projectDir, relativePath, entry, beforeWrite);
}

// A write lands through a temporary sibling, so the parent directory exists and
// is confined, and outside the control plane, before anything is written into it.
function confinedWriteTarget(
  projectDir: string,
  relativePath: string,
): { fullPath: string; temporary: string } {
  assertProjectWritablePathConfined(relativePath, projectDir);
  const fullPath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(fullPath));
  // Re-check after mkdir: creating the parent may have materialized a symlink.
  assertProjectWritablePathConfined(relativePath, projectDir);
  const temporary = join(
    dirname(fullPath),
    `.${basename(fullPath)}.tmp.${randomBytes(8).toString('hex')}`,
  );
  return { fullPath, temporary };
}

async function writeConfinedFileEntry(
  projectDir: string,
  relativePath: string,
  entry: ConfinedFileEntry,
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  const { fullPath, temporary } = confinedWriteTarget(projectDir, relativePath);
  const stat = (await lstatConfinedEntry(projectDir, relativePath))?.stat ?? null;
  if (stat?.isSymbolicLink()) throw fsError.symlinkWrite(fullPath);
  if (stat !== null) assertRegularEntry(fullPath, stat);
  try {
    // Bytes and permissions must both be ready before the target changes.
    await writeFile(temporary, entry.bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, entry.mode & 0o777);
    assertProjectWritablePathConfined(relativePath, projectDir);
    await observeConfinedEntry(projectDir, relativePath);
    await beforeWrite?.();
    if (stat === null) {
      // A create never clobbers a file that appeared after acquisition.
      await link(temporary, fullPath);
    } else {
      await rename(temporary, fullPath);
    }
  } finally {
    // The target is already committed after link/rename. A failed cleanup must
    // not misreport that successful write as an unapplied file.
    await rm(temporary, { force: true }).catch((err) =>
      warnError(`Could not remove promotion temporary file ${temporary}`, err),
    );
  }
}

/** Removes a symlink at `relativePath` itself, never what it points to; any other entry stays. */
export async function removeConfinedSymlink(
  projectDir: string,
  relativePath: string,
): Promise<void> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (!entry?.stat.isSymbolicLink()) return;
  // The realpath walk rejects a symlinked parent directory that escapes the root.
  assertExistingPathConfined(relative(projectDir, dirname(entry.fullPath)), projectDir);
  await unlink(entry.fullPath);
}

/** Creates the symlink, replacing a file or link already there; a directory there fails the rename. */
export async function writeConfinedSymlink(
  projectDir: string,
  relativePath: string,
  target: string,
): Promise<void> {
  const { fullPath, temporary } = confinedWriteTarget(projectDir, relativePath);
  await symlink(target, temporary);
  try {
    await rename(temporary, fullPath);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
}
