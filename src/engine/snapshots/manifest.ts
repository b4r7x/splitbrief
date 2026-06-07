import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { SnapshotManifestSchema } from '../../core/schemas/snapshot.js';
import {
  snapshotManifestPath,
  snapshotsDir,
  SNAPSHOT_BASELINE_ID,
  SNAPSHOT_MANIFEST_FILE,
} from '../../core/paths.js';
import { writeConfinedSecureFileAsync } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { error } from '../../utils/error.js';
import { isENOENT } from '../../lib/process/errors.js';
import { validateSafeIdentifier } from '../../utils/validate-identifier.js';

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSnapshotId(id: string): boolean {
  if (id === SNAPSHOT_BASELINE_ID) return true;
  const result = validateSafeIdentifier(id);
  if (!result.ok) return false;
  return SNAPSHOT_ID_PATTERN.test(id);
}

export async function writeManifest(
  projectDir: string,
  sessionId: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const target = snapshotManifestPath(projectDir, sessionId, manifest.id);
  await writeConfinedSecureFileAsync(
    projectDir,
    relative(projectDir, target),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function readManifest(
  projectDir: string,
  sessionId: string,
  snapshotId: string,
): Promise<SnapshotManifest> {
  if (!isValidSnapshotId(snapshotId)) {
    throw error('snapshot-invalid-id', `Invalid snapshot ID: ${snapshotId}`, { snapshotId });
  }
  const target = snapshotManifestPath(projectDir, sessionId, snapshotId);
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw error(
        'snapshot-manifest-symlink',
        `Refusing to read snapshot manifest through symlink: ${target}`,
        { target },
      );
    }
  } catch (cause: unknown) {
    if (!isENOENT(cause)) throw cause;
  }
  const relPath = relative(projectDir, target);
  if (!existsSync(target)) {
    throw error('snapshot-manifest-not-found', `Snapshot manifest not found: ${target}`);
  }
  assertExistingPathConfined(relPath, projectDir);
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
  const manifest = SnapshotManifestSchema.parse(parsed);
  if (manifest.sessionId !== sessionId) {
    throw error(
      'snapshot-manifest-session-mismatch',
      `Snapshot ${snapshotId} belongs to session ${manifest.sessionId}, not ${sessionId}`,
      { snapshotId, expectedSessionId: sessionId, actualSessionId: manifest.sessionId },
    );
  }
  return manifest;
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
    const name = entry.name as string;
    if (!isValidSnapshotId(name)) continue;
    const manifestPath = join(dir, name, SNAPSHOT_MANIFEST_FILE);
    try {
      await stat(manifestPath);
      ids.push(name);
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
