import { join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { snapshotFilesDir } from '../../core/paths.js';
import { encodeSnapshotPath } from './path-codec.js';
import { hashFile } from './files.js';

const VALID_ENCODED_NAME = /^[0-9a-f]{64}$/;

export type SnapshotBlobEntry = SnapshotManifest['fileEntries'][number];

// Resolve and validate the stored blob for a snapshot file entry before any
// read. Blobs are named `sha256(path)`, so a valid `encodedName` is a 64-char
// lowercase hex digest that equals the digest of the entry's own `path`. A
// tampered manifest can point `encodedName` outside snapshot storage or at a
// blob whose bytes no longer match the recorded hash; both must fail closed so
// a snapshot operation never reads or restores arbitrary outside content.
//
// Returns the validated absolute blob path, or `null` when the entry is invalid,
// the blob is missing, or its bytes do not match `entry.hash`.
export async function resolveValidatedBlobPath(opts: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  path: string;
  entry: SnapshotBlobEntry | undefined;
}): Promise<string | null> {
  const { projectDir, sessionId, snapshotId, path, entry } = opts;
  if (!entry) return null;
  if (!VALID_ENCODED_NAME.test(entry.encodedName)) return null;
  if (entry.encodedName !== encodeSnapshotPath(path)) return null;

  const blobPath = join(snapshotFilesDir(projectDir, sessionId, snapshotId), entry.encodedName);
  const blobHash = await hashFile(blobPath);
  if (blobHash === null || blobHash !== entry.hash) return null;
  return blobPath;
}
