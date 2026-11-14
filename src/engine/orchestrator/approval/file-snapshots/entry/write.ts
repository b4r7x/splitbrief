import { link, open, readdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { assertProjectWritablePathConfined } from '../../../../../core/scope/control-plane.js';
import { assertExistingPathConfined } from '../../../../../lib/fs/confinement.js';
import { fsError, nameWriteTarget } from '../../../../../lib/fs/secure.js';
import { warnError } from '../../../../../lib/warn.js';
import { isENOENT, isNodeError } from '../../../../../utils/errno.js';
import {
  type FileSnapshotEntry,
  observeConfinedEntry,
  type ConfinedFileEntry,
  lstatConfinedEntry,
  assertRegularEntry,
  type ChangeEntry,
} from './read.js';

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

const WRITE_TEMPORARY = /^\.(.+)\.tmp\.[0-9a-f]{16}$/;

/**
 * Removes the write temporaries a killed process left beside these paths. Its `finally` never ran,
 * and the next write of the same file picks a new name, so nothing else ever removes them.
 */
export async function removeWriteTemporaries(
  projectDir: string,
  relativePaths: readonly string[],
): Promise<void> {
  const namesByDir = new Map<string, Set<string>>();
  for (const relativePath of relativePaths) {
    const fullPath = resolve(projectDir, relativePath);
    const names = namesByDir.get(dirname(fullPath)) ?? new Set<string>();
    namesByDir.set(dirname(fullPath), names.add(basename(fullPath)));
  }
  for (const [dir, names] of namesByDir) {
    // A folder you removed, or replaced with a file, holds no temporaries.
    const entries = await readdir(dir).catch((cause: unknown) => {
      if (isENOENT(cause) || (isNodeError(cause) && cause.code === 'ENOTDIR')) return [];
      throw cause;
    });
    for (const entry of entries) {
      const name = WRITE_TEMPORARY.exec(entry)?.[1];
      if (name !== undefined && names.has(name)) await rm(join(dir, entry), { force: true });
    }
  }
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
  } catch (err) {
    throw nameWriteTarget(err, fullPath);
  } finally {
    // The target is already committed after link/rename. A failed cleanup must
    // not misreport that successful write as an unapplied file.
    await rm(temporary, { force: true }).catch((err) =>
      warnError(`Could not remove the temporary file ${relative(projectDir, temporary)}`, err),
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
