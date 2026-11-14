import type { open } from 'node:fs/promises';
import type { SECURE_FILE_MODE } from '../secure.js';

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

export type AtomicFileHandle = Awaited<ReturnType<typeof open>>;
export type AtomicSyncFileHandle = number;

export type AtomicFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
  isFile: () => boolean;
}>;

export type AtomicDirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

export type AtomicTarget = Readonly<{
  path: string;
  directory: string;
  directoryIdentity: AtomicDirectoryIdentity;
}>;

export type AtomicWriteSyncTarget = 'file' | 'directory';
export type AtomicWriteStatTarget = 'temporary' | 'target';

export type AtomicLockOwner = Readonly<{
  pid: number;
  startTimeMs: number;
  token: string;
}>;

export type AtomicLock = Readonly<{
  path: string;
  rawOwner: string;
  owner: AtomicLockOwner;
}>;

export type AtomicSyncLock = Readonly<{
  path: string;
  rawOwner: string;
  owner: AtomicLockOwner;
}>;

export type AtomicLockObservation = Readonly<{
  rawOwner: string;
  owner: AtomicLockOwner | null;
}>;
