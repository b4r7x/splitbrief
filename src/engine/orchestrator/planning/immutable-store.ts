import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import type { z } from 'zod';
import { sessionDir } from '../../../core/paths.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error, matches } from '../../../utils/error.js';
import { withFileLock } from '../../../lib/file-lock.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../../lib/fs.js';
import { assertWritablePathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';

export const MANIFEST_FILE = 'manifest.json';
export const CANDIDATE_PREFIX = '.candidate-';
const INSTALL_LOCK_FILE = '.install.lock';

export const briefGenerationStorageError = {
  oversized: (byteLength: number, limit: number) =>
    error(
      'brief-generation-oversized',
      `candidate generation is ${byteLength} bytes; the storage ceiling is ${limit} bytes`,
      { byteLength, limit },
    ),
  mismatch: (detail: string) =>
    error('brief-generation-mismatch', `stored generation diverges from its manifest: ${detail}`, {
      detail,
    }),
  quota: (totalBytes: number, limit: number) =>
    error(
      'brief-generation-quota',
      `candidate storage cannot reserve the generation allowance (${totalBytes} bytes used of ${limit})`,
      { totalBytes, limit },
    ),
  lockTimeout: (path: string) =>
    error(
      'brief-generation-lock-timeout',
      `another generation install holds the storage lock: ${path}`,
      {
        path,
      },
    ),
  invalid: (detail: string) =>
    error('brief-generation-invalid', `invalid generation storage content: ${detail}`, { detail }),
  isOversized: matches('brief-generation-oversized'),
  isMismatch: matches('brief-generation-mismatch'),
  isQuota: matches('brief-generation-quota'),
} as const;

export type ImmutableManifest = Readonly<{
  artifacts: readonly Readonly<{ name: string; sha256: string; byteLength: number }>[];
}>;

export type ImmutableArtifact = Readonly<{ name: string; text: string }>;

export type DirectoryExpectation = Readonly<{ id: string | null; manifestDigest: string | null }>;

export type VerifiedDirectory<TManifest extends ImmutableManifest> = Readonly<{
  id: string;
  manifestBytes: string;
  manifestDigest: string;
  manifest: TManifest;
  totalBytes: number;
  createdAtMs: number;
}>;

export type ImmutableInstallOperations = Readonly<{
  writeArtifact?: ((filePath: string, text: string) => void) | undefined;
  renameCandidate?: ((candidateDir: string, targetDir: string) => void) | undefined;
  fsyncDir?: ((dirPath: string) => void) | undefined;
}>;

export function verifyImmutableDirectory<TManifest extends ImmutableManifest>(
  input: Readonly<{
    dirPath: string;
    expectation: DirectoryExpectation;
    idPrefix: string;
    idDomain: string;
    manifestSchema: z.ZodType<TManifest>;
  }>,
): VerifiedDirectory<TManifest> {
  const manifestPath = join(input.dirPath, MANIFEST_FILE);
  let manifestStat: ReturnType<typeof lstatSync>;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    throw briefGenerationStorageError.mismatch(`missing ${MANIFEST_FILE}`);
  }
  if (manifestStat.isSymbolicLink()) {
    throw briefGenerationStorageError.mismatch(`${MANIFEST_FILE} is a symlink`);
  }
  const manifestBytes = readFileSync(manifestPath, 'utf8');
  const manifestDigest = sha256Hex(manifestBytes);
  const derivedId = `${input.idPrefix}${sha256Hex(`${input.idDomain}\u0000${manifestBytes}`)}`;
  if (input.expectation.id !== null && derivedId !== input.expectation.id) {
    throw briefGenerationStorageError.mismatch(
      'directory identity does not match its manifest bytes',
    );
  }
  if (
    input.expectation.manifestDigest !== null &&
    manifestDigest !== input.expectation.manifestDigest
  ) {
    throw briefGenerationStorageError.mismatch('manifest digest diverges');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes);
  } catch {
    throw briefGenerationStorageError.mismatch(`${MANIFEST_FILE} is not valid JSON`);
  }
  const manifestResult = input.manifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    throw briefGenerationStorageError.mismatch(
      `${MANIFEST_FILE} does not parse against its schema`,
    );
  }
  const manifest = manifestResult.data;
  const expectedFiles = new Set<string>([
    MANIFEST_FILE,
    ...manifest.artifacts.map((artifact) => artifact.name),
  ]);
  for (const name of readdirSync(input.dirPath)) {
    if (!expectedFiles.has(name)) {
      throw briefGenerationStorageError.mismatch(`unexpected file ${name}`);
    }
  }
  for (const artifact of manifest.artifacts) {
    const artifactPath = join(input.dirPath, artifact.name);
    let artifactStat: ReturnType<typeof lstatSync>;
    try {
      artifactStat = lstatSync(artifactPath);
    } catch {
      throw briefGenerationStorageError.mismatch(`missing artifact ${artifact.name}`);
    }
    if (artifactStat.isSymbolicLink()) {
      throw briefGenerationStorageError.mismatch(`${artifact.name} is a symlink`);
    }
    if (artifactStat.size !== artifact.byteLength) {
      throw briefGenerationStorageError.mismatch(`${artifact.name} length diverges`);
    }
    if (sha256Hex(readFileSync(artifactPath, 'utf8')) !== artifact.sha256) {
      throw briefGenerationStorageError.mismatch(`${artifact.name} digest diverges`);
    }
  }
  return {
    id: derivedId,
    manifestBytes,
    manifestDigest,
    manifest,
    totalBytes:
      manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0) +
      Buffer.byteLength(manifestBytes, 'utf8'),
    createdAtMs: statSync(input.dirPath).mtimeMs,
  };
}

export function installImmutableDirectory(
  input: Readonly<{
    ref: SessionRef;
    storeDirName: string;
    id: string;
    manifestBytes: string;
    manifestDigest: string;
    artifacts: readonly ImmutableArtifact[];
    verify: (
      dirPath: string,
      expectation: DirectoryExpectation,
    ) => VerifiedDirectory<ImmutableManifest>;
    operations: ImmutableInstallOperations;
  }>,
): 'installed' | 'reused' {
  const storeDir = storeRoot(input.ref, input.storeDirName);
  ensureSecureDir(storeDir);
  assertWritablePathConfined(relative(input.ref.projectDir, storeDir), input.ref.projectDir);
  const targetDir = join(storeDir, input.id);
  const lockPath = join(storeDir, INSTALL_LOCK_FILE);
  return withFileLock(
    lockPath,
    () => briefGenerationStorageError.lockTimeout(lockPath),
    () => {
      if (existsSync(targetDir)) {
        input.verify(targetDir, { id: input.id, manifestDigest: null });
        return 'reused';
      }
      const candidateDir = join(storeDir, `${CANDIDATE_PREFIX}${randomBytes(8).toString('hex')}`);
      ensureSecureDir(candidateDir);
      try {
        const writeArtifact = input.operations.writeArtifact ?? writeExclusiveFileSync;
        for (const artifact of input.artifacts) {
          writeArtifact(join(candidateDir, artifact.name), artifact.text);
        }
        writeArtifact(join(candidateDir, MANIFEST_FILE), input.manifestBytes);
        const fsyncDir = input.operations.fsyncDir ?? fsyncDirectorySync;
        fsyncDir(candidateDir);
        input.verify(candidateDir, { id: null, manifestDigest: input.manifestDigest });
        const renameCandidate = input.operations.renameCandidate ?? renameSync;
        renameCandidate(candidateDir, targetDir);
        fsyncDir(storeDir);
        return 'installed';
      } finally {
        rmSync(candidateDir, { recursive: true, force: true });
      }
    },
  );
}

type StoreEntry = Readonly<{ id: string; totalBytes: number }>;
type CandidateEntry = Readonly<{ name: string; totalBytes: number; storeDirName: string }>;

export type StoreScan<TManifest extends ImmutableManifest> = Readonly<{
  verified: readonly VerifiedDirectory<TManifest>[];
  unverified: readonly StoreEntry[];
  candidates: readonly CandidateEntry[];
  totalBytes: number;
}>;

export function scanStore<TManifest extends ImmutableManifest>(
  ref: SessionRef,
  storeDirName: string,
  verify: (dirPath: string, expectation: DirectoryExpectation) => VerifiedDirectory<TManifest>,
): StoreScan<TManifest> {
  const storeDir = storeRoot(ref, storeDirName);
  if (!existsSync(storeDir)) return { verified: [], unverified: [], candidates: [], totalBytes: 0 };
  const verified: VerifiedDirectory<TManifest>[] = [];
  const unverified: StoreEntry[] = [];
  const candidates: CandidateEntry[] = [];
  let totalBytes = 0;
  for (const name of readdirSync(storeDir)) {
    if (name === INSTALL_LOCK_FILE) continue;
    const dirPath = join(storeDir, name);
    if (name.startsWith(CANDIDATE_PREFIX)) {
      const bytes = directoryByteCountSync(dirPath);
      candidates.push({ name, totalBytes: bytes, storeDirName });
      totalBytes += bytes;
      continue;
    }
    try {
      const verifiedEntry = verify(dirPath, { id: name, manifestDigest: null });
      verified.push(verifiedEntry);
      totalBytes += verifiedEntry.totalBytes;
    } catch {
      const bytes = directoryByteCountSync(dirPath);
      unverified.push({ id: name, totalBytes: bytes });
      totalBytes += bytes;
    }
  }
  return { verified, unverified, candidates, totalBytes };
}

export function storeRoot(ref: SessionRef, storeDirName: string): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), storeDirName);
}

function writeExclusiveFileSync(filePath: string, text: string): void {
  const fd = openSync(filePath, 'wx', SECURE_FILE_MODE);
  try {
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectorySync(dirPath: string): void {
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function directoryByteCountSync(dirPath: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dirPath)) {
      const filePath = join(dirPath, name);
      const entryStat = lstatSync(filePath);
      total += entryStat.isDirectory() ? directoryByteCountSync(filePath) : entryStat.size;
    }
  } catch (err) {
    if (isENOENT(err)) return 0;
    throw err;
  }
  return total;
}
