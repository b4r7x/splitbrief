import { constants, type BigIntStats } from 'node:fs';
import { artifactStageError } from './capture.js';
import type { ArtifactFileHandle } from './types.js';

export async function readHandleStat(handle: ArtifactFileHandle): Promise<BigIntStats> {
  return handle.stat({ bigint: true });
}

export function artifactOpenFlags(): number {
  return (
    constants.O_RDWR |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  );
}

export function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST';
}

export async function writeAll(handle: ArtifactFileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw artifactStageError.invalid('declared artifact lease could not be created safely');
    }
    offset += bytesWritten;
  }
}
