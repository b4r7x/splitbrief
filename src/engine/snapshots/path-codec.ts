import { sha256Hex } from '../../utils/sha256.js';

export function encodeSnapshotPath(relativePath: string): string {
  return sha256Hex(relativePath);
}

export function generateSnapshotId(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/[:.]/g, '-');
}
