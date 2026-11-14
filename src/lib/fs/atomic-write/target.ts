import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hasErrnoCode, isENOENT } from '../../../utils/errno.js';
import { fsError } from '../secure.js';
import type { AtomicDirectoryIdentity, AtomicTarget } from './types.js';

export function isNoFollowFailure(err: unknown): boolean {
  return hasErrnoCode(err, 'ELOOP');
}

export function isAlreadyExists(err: unknown): boolean {
  return hasErrnoCode(err, 'EEXIST');
}

export function isDirectorySyncUnsupported(err: unknown): boolean {
  return hasErrnoCode(err, 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP');
}

function directoryIdentityMatches(
  left: AtomicDirectoryIdentity,
  right: AtomicDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const DARWIN_PATH_ALIASES = [
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
] as const;

function isAllowedAtomicPathAlias(path: string, realPath: string): boolean {
  if (path === realPath) return true;
  if (process.platform !== 'darwin') return false;
  return DARWIN_PATH_ALIASES.some(([alias, canonical]) => {
    return (
      (path === alias && realPath === canonical) ||
      (path.startsWith(`${alias}/`) &&
        realPath.startsWith(`${canonical}/`) &&
        realPath.slice(canonical.length) === path.slice(alias.length))
    );
  });
}

function isAllowedAtomicAliasComponent(path: string, realPath: string): boolean {
  if (process.platform !== 'darwin') return false;
  return DARWIN_PATH_ALIASES.some(([alias, canonical]) => path === alias && realPath === canonical);
}

async function assertAtomicDirectoryNoFollow(
  directory: string,
  realDirectory: string,
): Promise<void> {
  let current = resolve(directory);
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      const realCurrent = await realpath(current);
      if (!isAllowedAtomicAliasComponent(current, realCurrent)) {
        throw fsError.symlinkWrite(current);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!isAllowedAtomicPathAlias(resolve(directory), realDirectory)) {
    throw fsError.symlinkWrite(directory);
  }
}

async function atomicDirectoryIdentity(directory: string): Promise<AtomicDirectoryIdentity> {
  const realDirectory = await realpath(directory);
  if (realDirectory !== directory) throw fsError.symlinkWrite(directory);
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw fsError.invalidId('atomic parent directory', directory, 'must be a real directory');
  }
  return { dev: stat.dev, ino: stat.ino };
}

export async function canonicalAtomicTarget(path: string): Promise<AtomicTarget> {
  const target = resolve(path);
  // Resolve the parent once so platform aliases such as macOS `/var` ->
  // `/private/var` do not look like a symlink write. The identity captured here
  // still fences the directory against replacement during the operation.
  const requestedDirectory = dirname(target);
  const directory = await realpath(requestedDirectory);
  await assertAtomicDirectoryNoFollow(requestedDirectory, directory);
  return {
    path: join(directory, basename(target)),
    directory,
    directoryIdentity: await atomicDirectoryIdentity(directory),
  };
}

export async function assertAtomicDirectoryIdentity(target: AtomicTarget): Promise<void> {
  let current: AtomicDirectoryIdentity;
  try {
    current = await atomicDirectoryIdentity(target.directory);
  } catch (err) {
    if (isENOENT(err)) {
      throw fsError.invalidId(
        'atomic parent directory',
        target.directory,
        'changed during replacement',
      );
    }
    throw err;
  }
  if (!directoryIdentityMatches(target.directoryIdentity, current)) {
    throw fsError.invalidId(
      'atomic parent directory',
      target.directory,
      'changed during replacement',
    );
  }
}

export async function assertAtomicTargetIsNotSymlink(target: AtomicTarget): Promise<void> {
  await assertAtomicDirectoryIdentity(target);
  try {
    if ((await lstat(target.path)).isSymbolicLink()) throw fsError.symlinkWrite(target.path);
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
}

function atomicDirectoryIdentitySync(directory: string): AtomicDirectoryIdentity {
  const realDirectory = realpathSync(directory);
  if (realDirectory !== directory) throw fsError.symlinkWrite(directory);
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw fsError.invalidId('atomic parent directory', directory, 'must be a real directory');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertAtomicDirectoryNoFollowSync(directory: string, realDirectory: string): void {
  let current = resolve(directory);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const realCurrent = realpathSync(current);
      if (!isAllowedAtomicAliasComponent(current, realCurrent)) {
        throw fsError.symlinkWrite(current);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!isAllowedAtomicPathAlias(resolve(directory), realDirectory)) {
    throw fsError.symlinkWrite(directory);
  }
}

export function canonicalAtomicTargetSync(path: string): AtomicTarget {
  const target = resolve(path);
  // Resolve the parent once so platform aliases such as macOS `/var` ->
  // `/private/var` do not look like a symlink write. The identity captured here
  // still fences the directory against replacement during the operation.
  const requestedDirectory = dirname(target);
  const directory = realpathSync(requestedDirectory);
  assertAtomicDirectoryNoFollowSync(requestedDirectory, directory);
  return {
    path: join(directory, basename(target)),
    directory,
    directoryIdentity: atomicDirectoryIdentitySync(directory),
  };
}

export function assertAtomicDirectoryIdentitySync(target: AtomicTarget): void {
  let current: AtomicDirectoryIdentity;
  try {
    current = atomicDirectoryIdentitySync(target.directory);
  } catch (err) {
    if (isENOENT(err)) {
      throw fsError.invalidId(
        'atomic parent directory',
        target.directory,
        'changed during replacement',
      );
    }
    throw err;
  }
  if (!directoryIdentityMatches(target.directoryIdentity, current)) {
    throw fsError.invalidId(
      'atomic parent directory',
      target.directory,
      'changed during replacement',
    );
  }
}

export function assertAtomicTargetIsNotSymlinkSync(target: AtomicTarget): void {
  assertAtomicDirectoryIdentitySync(target);
  try {
    if (lstatSync(target.path).isSymbolicLink()) throw fsError.symlinkWrite(target.path);
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
}
