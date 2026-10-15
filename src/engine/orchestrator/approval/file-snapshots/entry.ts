import {
  link,
  lstat,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { mkdirSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fsError } from '../../../../lib/fs.js';
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

/** An entry as a change record holds it: a symlink by its target, the way git records it. */
export type ChangeEntry = FileSnapshotEntry | { kind: 'symlink'; target: string };

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

/** The confined entry, a symlink by its target and never read through. */
export async function readChangeEntry(
  projectDir: string,
  relativePath: string,
): Promise<ChangeEntry> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry?.stat.isSymbolicLink()) {
    assertExistingPathConfined(dirname(relativePath), projectDir);
    return { kind: 'symlink', target: await readlink(entry.fullPath) };
  }
  return readConfinedEntry(projectDir, relativePath);
}

// Where the kernel lands `path` once its missing directories exist: name by
// name, through every link on the way, dangling or not. Null past the kernel's
// link limit: a dangling link that climbs back through itself never lands.
async function kernelLanding(path: string, links = { left: 40 }): Promise<string | null> {
  let landing = parse(path).root;
  for (const segment of path.split(sep)) {
    if (segment === '..') landing = dirname(landing);
    else if (segment !== '' && segment !== '.') {
      const next = await nameLanding(join(landing, segment), links);
      if (next === null) return null;
      landing = next;
    }
  }
  return landing;
}

async function nameLanding(path: string, links: { left: number }): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  const stat = await lstat(path).catch((err: unknown) => {
    if (isENOENT(err)) return null;
    throw err;
  });
  if (!stat?.isSymbolicLink()) return path;
  if (links.left === 0) return null;
  links.left -= 1;
  const target = await readlink(path);
  return kernelLanding(isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`, links);
}

/**
 * The target of a symlink that stays inside the project: a relative target that
 * climbs only in one leading run of `..` that stays inside the root, then names,
 * so it names the same place in the worktree and the staged copy; and that the
 * kernel lands inside the root and outside the control plane, following every
 * link on the way, dangling or not.
 * Null for any other entry; `readConfinedEntry` refuses every link.
 */
export async function readProjectSymlink(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry === null || !entry.stat.isSymbolicLink()) return null;
  const target = await readlink(entry.fullPath);
  return (await linkStaysInProject(projectDir, relativePath, target)) ? target : null;
}

/** A link to `target` at `relativePath` stays inside the project, as `readProjectSymlink` reads one. */
export async function linkStaysInProject(
  projectDir: string,
  relativePath: string,
  target: string,
): Promise<boolean> {
  if (isAbsolute(target)) return false;
  const fullPath = resolve(projectDir, relativePath);
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
      if (named || depth < 0) return false;
    } else if (segment !== '' && segment !== '.') {
      named = true;
    }
  }
  let landed: string | null;
  try {
    landed = await kernelLanding(`${dirname(fullPath)}${sep}${target}`);
  } catch {
    // A loop, or a file or an unreadable directory on the way: it lands nowhere.
    return false;
  }
  if (landed === null) return false;
  // A link into `.git` or `.splitbrief` gives the control plane a second name.
  const first = relative(await realpath(projectDir), landed).split(sep)[0] ?? '';
  return first !== '..' && !CONTROL_PLANE_SEGMENTS.has(first);
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

export function sameChangeEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  if (a.kind === 'symlink' || b.kind === 'symlink') {
    return a.kind === 'symlink' && b.kind === 'symlink' && a.target === b.target;
  }
  return sameFileEntry(a, b);
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
  mkdirSync(dirname(fullPath), { recursive: true });
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
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(entry.bytes);
      await handle.chmod(entry.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
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

/**
 * Writes a file, a symlink or nothing at `relativePath`, over a file or a
 * symlink already there; a symlink there is replaced, never written through.
 */
export async function writeConfinedEntryOrLink(
  projectDir: string,
  relativePath: string,
  entry: ChangeEntry,
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  if (entry.kind === 'symlink') {
    await beforeWrite?.();
    await writeConfinedSymlink(projectDir, relativePath, entry.target);
    return;
  }
  if (!(await lstatConfinedEntry(projectDir, relativePath))?.stat.isSymbolicLink()) {
    await writeConfinedEntry(projectDir, relativePath, entry, beforeWrite);
    return;
  }
  await beforeWrite?.();
  await removeConfinedSymlink(projectDir, relativePath);
  await writeConfinedEntry(projectDir, relativePath, entry);
}
