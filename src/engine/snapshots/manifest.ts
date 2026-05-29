import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { SnapshotManifestSchema } from '../../core/schemas/snapshot.js';
import {
  snapshotManifestPath,
  snapshotsDir,
  SNAPSHOT_BASELINE_ID,
  SNAPSHOT_MANIFEST_FILE,
} from '../../core/paths.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { error } from '../../utils/error.js';

export async function writeManifest(
  projectDir: string,
  sessionId: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const target = snapshotManifestPath(projectDir, sessionId, manifest.id);
  await writeSecureFileAsync(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifest(
  projectDir: string,
  sessionId: string,
  snapshotId: string,
): Promise<SnapshotManifest> {
  const target = snapshotManifestPath(projectDir, sessionId, snapshotId);
  let raw: string;
  try {
    raw = await readFile(target, 'utf-8');
  } catch (cause) {
    throw error(
      'snapshot-manifest-not-found',
      `Snapshot manifest not found: ${target}`,
      undefined,
      cause,
    );
  }
  const parsed = JSON.parse(raw);
  return SnapshotManifestSchema.parse(parsed);
}

export async function listSnapshotIds(projectDir: string, sessionId: string): Promise<string[]> {
  const dir = snapshotsDir(projectDir, sessionId);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name as string, SNAPSHOT_MANIFEST_FILE);
    try {
      await stat(manifestPath);
      ids.push(entry.name as string);
    } catch {
      // Skip dirs without a manifest
    }
  }
  ids.sort();
  return ids;
}

export async function hasBaseline(projectDir: string, sessionId: string): Promise<boolean> {
  const manifestPath = snapshotManifestPath(projectDir, sessionId, 'baseline');
  try {
    await stat(manifestPath);
    return true;
  } catch {
    return false;
  }
}

export type ListSnapshotsResult = {
  manifests: SnapshotManifest[];
  corruptedIds: string[];
};

export async function listSnapshots(
  projectDir: string,
  sessionId: string,
): Promise<ListSnapshotsResult> {
  const ids = await listSnapshotIds(projectDir, sessionId);
  const manifests: SnapshotManifest[] = [];
  const corruptedIds: string[] = [];
  for (const id of ids) {
    if (id === SNAPSHOT_BASELINE_ID) continue;
    try {
      const manifest = await readManifest(projectDir, sessionId, id);
      manifests.push(manifest);
    } catch {
      corruptedIds.push(id);
    }
  }
  manifests.sort((a, b) => a.id.localeCompare(b.id));
  return { manifests, corruptedIds };
}
