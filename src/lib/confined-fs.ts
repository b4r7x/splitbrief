import {
  constants,
  existsSync,
  readFileSync,
  appendFileSync,
  lstatSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  pathConfinementError,
} from './path-confinement.js';
import { fsError, writeSecureFile, ensureSecureDir, SECURE_FILE_MODE } from './fs.js';
import { isENOENT, isNodeError } from './process/errors.js';

export type ConfigRevision = Readonly<{
  rawSha256: string;
  fileIdentity: Readonly<{
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  }>;
}>;

export type ExpectedConfigRevision = ConfigRevision | null;

export type ConfinedAtomicWriteResult =
  | Readonly<{ kind: 'written'; revision: ConfigRevision }>
  | Readonly<{ kind: 'conflict'; observedRevision: ConfigRevision | null }>
  | Readonly<{ kind: 'durability-uncertain'; observedRevision: ConfigRevision }>;

export type ConfinedAtomicWriteOptions = Readonly<{
  expectedRevision: ExpectedConfigRevision;
  mode: typeof SECURE_FILE_MODE;
}>;

type AtomicFileHandle = Awaited<ReturnType<typeof open>>;

type AtomicFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
  isFile: () => boolean;
}>;

type AtomicDirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type AtomicTarget = Readonly<{
  path: string;
  directory: string;
  directoryIdentity: AtomicDirectoryIdentity;
}>;

type AtomicWriteSyncTarget = 'file' | 'directory';
type AtomicWriteStatTarget = 'temporary' | 'target';

export type ConfinedAtomicWriteTestOperations = Readonly<{
  open?: (path: string, flags: number, mode?: number) => Promise<AtomicFileHandle>;
  write?: (
    handle: AtomicFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<Readonly<{ bytesWritten: number }>>;
  read?: (
    handle: AtomicFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<Readonly<{ bytesRead: number }>>;
  fsync?: (handle: AtomicFileHandle, target: AtomicWriteSyncTarget) => Promise<void>;
  chmod?: (handle: AtomicFileHandle, mode: number) => Promise<void>;
  stat?: (handle: AtomicFileHandle, target: AtomicWriteStatTarget) => Promise<AtomicFileStat>;
  rename?: (from: string, to: string) => Promise<void>;
  link?: (from: string, to: string) => Promise<void>;
}>;

type AtomicWriteOperations = Required<ConfinedAtomicWriteTestOperations>;

type RevisionRead = Readonly<{
  revision: ConfigRevision;
  stat: AtomicFileStat;
}>;

const ATOMIC_READ_CHUNK_BYTES = 64 * 1024;

function atomicWriteOperations(
  injected: ConfinedAtomicWriteTestOperations | undefined,
): AtomicWriteOperations {
  return {
    open: injected?.open ?? ((path, flags, mode) => open(path, flags, mode)),
    write:
      injected?.write ??
      (async (handle, bytes, offset, length, position) => {
        const result = await handle.write(bytes, offset, length, position);
        return { bytesWritten: result.bytesWritten };
      }),
    read:
      injected?.read ??
      (async (handle, bytes, offset, length, position) => {
        const result = await handle.read(bytes, offset, length, position);
        return { bytesRead: result.bytesRead };
      }),
    fsync: injected?.fsync ?? (async (handle) => handle.sync()),
    chmod: injected?.chmod ?? (async (handle, mode) => handle.chmod(mode)),
    stat: injected?.stat ?? (async (handle) => handle.stat({ bigint: true })),
    rename: injected?.rename ?? rename,
    link: injected?.link ?? link,
  };
}

function revisionFromStat(rawSha256: string, stat: AtomicFileStat): ConfigRevision {
  return {
    rawSha256,
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertAtomicMode(mode: number): asserts mode is typeof SECURE_FILE_MODE {
  if (mode !== SECURE_FILE_MODE) {
    throw fsError.invalidId('atomic file mode', mode.toString(8), 'must be owner-only (0600)');
  }
}

function assertRegularFile(path: string, stat: AtomicFileStat): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('atomic target', path, 'must be a regular file');
  }
}

function assertRegularOwnerOnly(path: string, stat: AtomicFileStat): void {
  assertRegularFile(path, stat);
  if ((stat.mode & 0o077n) !== 0n) {
    throw fsError.invalidId('atomic target', path, 'must be a regular owner-only file');
  }
}

function isNoFollowFailure(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ELOOP';
}

function isAlreadyExists(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EEXIST';
}

function isDirectorySyncUnsupported(err: unknown): boolean {
  return (
    isNodeError(err) &&
    (err.code === 'EINVAL' || err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP')
  );
}

function directoryIdentityMatches(
  left: AtomicDirectoryIdentity,
  right: AtomicDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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

async function canonicalAtomicTarget(path: string): Promise<AtomicTarget> {
  const target = resolve(path);
  const directory = dirname(target);
  return {
    path: target,
    directory,
    directoryIdentity: await atomicDirectoryIdentity(directory),
  };
}

async function assertAtomicDirectoryIdentity(target: AtomicTarget): Promise<void> {
  const current = await atomicDirectoryIdentity(target.directory);
  if (!directoryIdentityMatches(target.directoryIdentity, current)) {
    throw fsError.invalidId(
      'atomic parent directory',
      target.directory,
      'changed during replacement',
    );
  }
}

async function assertAtomicTargetIsNotSymlink(target: AtomicTarget): Promise<void> {
  await assertAtomicDirectoryIdentity(target);
  try {
    if ((await lstat(target.path)).isSymbolicLink()) throw fsError.symlinkWrite(target.path);
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
}

async function readRevision(
  handle: AtomicFileHandle,
  operations: AtomicWriteOperations,
  statTarget: AtomicWriteStatTarget,
): Promise<RevisionRead> {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(ATOMIC_READ_CHUNK_BYTES);
  let position = 0;

  while (true) {
    const { bytesRead } = await operations.read(handle, chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > chunk.byteLength) {
      throw fsError.invalidId(
        'atomic read length',
        String(bytesRead),
        'must be within the read buffer',
      );
    }
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }

  const stat = await operations.stat(handle, statTarget);
  return { revision: revisionFromStat(digest.digest('hex'), stat), stat };
}

async function readTargetRevision(
  target: AtomicTarget,
  operations: AtomicWriteOperations,
  requireOwnerOnly: boolean,
): Promise<RevisionRead | null> {
  await assertAtomicDirectoryIdentity(target);
  let handle: AtomicFileHandle;
  try {
    handle = await operations.open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return null;
    if (isNoFollowFailure(err)) throw fsError.symlinkWrite(target.path);
    throw err;
  }

  try {
    const read = await readRevision(handle, operations, 'target');
    assertRegularFile(target.path, read.stat);
    if (requireOwnerOnly) assertRegularOwnerOnly(target.path, read.stat);
    return read;
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: AtomicFileHandle,
  bytes: Uint8Array,
  operations: AtomicWriteOperations,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const { bytesWritten } = await operations.write(handle, bytes, offset, remaining, offset);
    if (bytesWritten <= 0 || bytesWritten > remaining) {
      throw fsError.invalidId(
        'atomic write length',
        String(bytesWritten),
        'must advance within bytes',
      );
    }
    offset += bytesWritten;
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

async function syncDirectory(
  target: AtomicTarget,
  operations: AtomicWriteOperations,
): Promise<void> {
  await assertAtomicDirectoryIdentity(target);
  let directory: AtomicFileHandle;
  try {
    directory = await operations.open(
      target.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  }

  try {
    await operations.fsync(directory, 'directory');
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  } finally {
    await directory.close();
  }
}

function temporaryPath(target: AtomicTarget): string {
  return join(target.directory, `.${basename(target.path)}.tmp.${randomBytes(16).toString('hex')}`);
}

async function confinedAtomicWriteFileWithOperations(
  path: string,
  sourceBytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: AtomicWriteOperations,
): Promise<ConfinedAtomicWriteResult> {
  assertAtomicMode(options.mode);
  const bytes = Buffer.from(sourceBytes);
  const target = await canonicalAtomicTarget(path);
  await assertAtomicTargetIsNotSymlink(target);

  let tempPath: string | null = null;
  let renamed = false;
  let replacementRevision: ConfigRevision | null = null;
  let observedRevision: ConfigRevision | null = null;

  try {
    await assertAtomicDirectoryIdentity(target);
    tempPath = temporaryPath(target);
    const temporary = await operations.open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      options.mode,
    );

    try {
      await operations.chmod(temporary, options.mode);
      await writeAll(temporary, bytes, operations);
      await operations.fsync(temporary, 'file');
      const temporaryStat = await operations.stat(temporary, 'temporary');
      assertRegularOwnerOnly(tempPath, temporaryStat);
      replacementRevision = revisionFromStat(sha256(bytes), temporaryStat);
    } finally {
      await temporary.close();
    }

    const current = await readTargetRevision(target, operations, false);
    const expectedMatches =
      options.expectedRevision === null
        ? current === null
        : current !== null && revisionsMatch(options.expectedRevision, current.revision);
    if (!expectedMatches) {
      await removeTemporaryFile(tempPath);
      tempPath = null;
      return { kind: 'conflict', observedRevision: current?.revision ?? null };
    }

    if (replacementRevision === null) {
      throw fsError.invalidId(
        'atomic replacement revision',
        'missing',
        'must be recorded before rename',
      );
    }
    const plannedRevision = replacementRevision;
    await assertAtomicDirectoryIdentity(target);
    if (options.expectedRevision === null) {
      try {
        await operations.link(tempPath, target.path);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        const raced = await readTargetRevision(target, operations, false);
        await removeTemporaryFile(tempPath);
        tempPath = null;
        return { kind: 'conflict', observedRevision: raced?.revision ?? null };
      }
      renamed = true;
      await removeTemporaryFile(tempPath);
    } else {
      await operations.rename(tempPath, target.path);
      renamed = true;
    }
    tempPath = null;

    const final = await readTargetRevision(target, operations, true);
    if (final !== null) observedRevision = final.revision;
    await syncDirectory(target, operations);

    if (observedRevision === null || !revisionsMatch(plannedRevision, observedRevision)) {
      return {
        kind: 'durability-uncertain',
        observedRevision: observedRevision ?? plannedRevision,
      };
    }
    return { kind: 'written', revision: observedRevision };
  } catch (err) {
    if (renamed && replacementRevision !== null) {
      return {
        kind: 'durability-uncertain',
        observedRevision: observedRevision ?? replacementRevision,
      };
    }
    if (tempPath !== null) await removeTemporaryFile(tempPath);
    throw err;
  }
}

export async function confinedAtomicWriteFile(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
): Promise<ConfinedAtomicWriteResult> {
  return confinedAtomicWriteFileWithOperations(
    path,
    bytes,
    options,
    atomicWriteOperations(undefined),
  );
}

export async function confinedAtomicWriteFileForTest(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: ConfinedAtomicWriteTestOperations,
): Promise<ConfinedAtomicWriteResult> {
  return confinedAtomicWriteFileWithOperations(
    path,
    bytes,
    options,
    atomicWriteOperations(operations),
  );
}

function isPathConfinementReadError(err: unknown): boolean {
  return (
    pathConfinementError.isSymlinkRead(err) ||
    (typeof err === 'object' &&
      err !== null &&
      'kind' in err &&
      (err.kind === 'path-confined-escape' || err.kind === 'path-confined-absolute'))
  );
}

function resolveConfinedReadPath(projectDir: string, relativePath: string): string | null {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  if (!existsSync(filePath)) return null;
  assertExistingPathConfined(relativePath, projectDir);
  const st = lstatSync(filePath);
  if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  return filePath;
}

export function confinedReadFile(projectDir: string, relativePath: string): string | null {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    return null;
  }
}

export async function confinedReadFileAsync(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    return null;
  }
}

export async function confinedReadFileOrEmpty(
  projectDir: string,
  relativePath: string,
): Promise<string> {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return '';
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) throw err;
    if (isENOENT(err)) return '';
    throw err;
  }
}

export function confinedWriteFile(projectDir: string, relativePath: string, content: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  writeSecureFile(filePath, content);
}

export function confinedAppendFileSync(
  projectDir: string,
  relativePath: string,
  content: string,
): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) throw err;
  }
  appendFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  chmodSync(filePath, SECURE_FILE_MODE);
}

export function confinedUnlinkSync(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  unlinkSync(filePath);
}

export function confinedEnsureDir(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const dirPath = resolve(projectDir, relativePath);
  ensureSecureDir(dirPath);
  assertWritablePathConfined(relativePath, projectDir);
}

export function confinedExists(projectDir: string, relativePath: string): boolean {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  return existsSync(filePath);
}
