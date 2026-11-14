import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { link, open, rename } from 'node:fs/promises';
import type {
  AtomicFileHandle,
  AtomicWriteSyncTarget,
  AtomicWriteStatTarget,
  AtomicFileStat,
  ExpectedConfigRevision,
  ConfigRevision,
  AtomicSyncFileHandle,
} from './types.js';

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
  compare?: (
    expectedRevision: ExpectedConfigRevision,
    observedRevision: ConfigRevision | null,
  ) => void | Promise<void>;
  beforeLockPublish?: (path: string) => void | Promise<void>;
  beforeLockMove?: (path: string) => void | Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  link?: (from: string, to: string) => Promise<void>;
}>;

export type ConfinedAtomicWriteSyncTestOperations = Readonly<{
  open?: (path: string, flags: number, mode?: number) => AtomicSyncFileHandle;
  write?: (
    handle: AtomicSyncFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  read?: (
    handle: AtomicSyncFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  fsync?: (handle: AtomicSyncFileHandle, target: AtomicWriteSyncTarget) => void;
  chmod?: (handle: AtomicSyncFileHandle, mode: number) => void;
  stat?: (handle: AtomicSyncFileHandle, target: AtomicWriteStatTarget) => AtomicFileStat;
  close?: (handle: AtomicSyncFileHandle) => void;
  compare?: (
    expectedRevision: ExpectedConfigRevision,
    observedRevision: ConfigRevision | null,
  ) => void;
  beforeLockPublish?: (path: string) => void;
  beforeLockMove?: (path: string) => void;
  rename?: (from: string, to: string) => void;
  link?: (from: string, to: string) => void;
}>;

export type AtomicWriteOperations = Required<ConfinedAtomicWriteTestOperations>;
export type AtomicWriteSyncOperations = Required<ConfinedAtomicWriteSyncTestOperations>;

export function atomicWriteOperations(
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
    compare: injected?.compare ?? (async () => undefined),
    beforeLockPublish: injected?.beforeLockPublish ?? (async () => undefined),
    beforeLockMove: injected?.beforeLockMove ?? (async () => undefined),
    rename: injected?.rename ?? rename,
    link: injected?.link ?? link,
  };
}

export function atomicWriteSyncOperations(
  injected: ConfinedAtomicWriteSyncTestOperations | undefined,
): AtomicWriteSyncOperations {
  return {
    open:
      injected?.open ??
      ((path, flags, mode) =>
        mode === undefined ? openSync(path, flags) : openSync(path, flags, mode)),
    write:
      injected?.write ??
      ((handle, bytes, offset, length, position) =>
        writeSync(handle, bytes, offset, length, position)),
    read:
      injected?.read ??
      ((handle, bytes, offset, length, position) =>
        readSync(handle, bytes, offset, length, position)),
    fsync: injected?.fsync ?? ((handle) => fsyncSync(handle)),
    chmod: injected?.chmod ?? ((handle, mode) => fchmodSync(handle, mode)),
    stat: injected?.stat ?? ((handle) => fstatSync(handle, { bigint: true })),
    close: injected?.close ?? closeSync,
    compare: injected?.compare ?? (() => undefined),
    beforeLockPublish: injected?.beforeLockPublish ?? (() => undefined),
    beforeLockMove: injected?.beforeLockMove ?? (() => undefined),
    rename: injected?.rename ?? renameSync,
    link: injected?.link ?? linkSync,
  };
}
