import { it } from 'vitest';
import type { FileSnapshotEntry } from '../../src/engine/orchestrator/approval/file-snapshots/entry/read.js';
import { sha256Hex } from '../../src/utils/sha256.js';

export const itUnix = process.platform === 'win32' ? it.skip : it;

export function fileEntry(bytes: Buffer, mode: number): FileSnapshotEntry {
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode };
}
