import { createHash } from 'node:crypto';
import {
  createReadStream,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SnapshotFileEntry, SnapshotManifest, SnapshotPhase } from '../../core/schemas/snapshot.js';
import { SnapshotManifestSchema } from '../../core/schemas/snapshot.js';
import {
  baselineDir,
  snapshotDir,
  snapshotFilesDir,
  snapshotLockPath,
  snapshotManifestPath,
  snapshotsDir,
  SNAPSHOT_BASELINE_ID,
  SNAPSHOT_MANIFEST_FILE,
} from '../../core/paths.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../lib/fs.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';

export function encodeSnapshotPath(relativePath: string): string {
  return relativePath.split('/').map(segment => encodeURIComponent(segment)).join('__');
}

export function decodeSnapshotPath(encodedName: string): string {
  return encodedName.split('__').map(segment => decodeURIComponent(segment)).join('/');
}

export function generateSnapshotId(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/[:.]/g, '-');
}

export async function writeManifest(
  projectDir: string,
  sessionId: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const dir = snapshotDir(projectDir, sessionId, manifest.id);
  ensureSecureDir(dir);
  const target = snapshotManifestPath(projectDir, sessionId, manifest.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: SECURE_FILE_MODE });
  await rename(tmp, target);
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
  } catch {
    throw new Error(`Snapshot manifest not found: ${target}`);
  }
  const parsed = JSON.parse(raw);
  return SnapshotManifestSchema.parse(parsed);
}

export async function listSnapshotIds(projectDir: string, sessionId: string): Promise<string[]> {
  const dir = snapshotsDir(projectDir, sessionId);
  let entries: import('node:fs').Dirent[];
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

export async function hashFile(filePath: string): Promise<string | null> {
  return new Promise(resolve => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', () => resolve(null));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const ALWAYS_EXCLUDED = ['.git', '.diptych', 'node_modules'];

async function readdirRecursive(dir: string, base: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const name = entry.name as string;
    const rel = relative(base, join(dir, name));
    const topLevel = rel.split('/')[0];
    if (topLevel !== undefined && ALWAYS_EXCLUDED.includes(topLevel)) continue;
    if (entry.isDirectory()) {
      const children = await readdirRecursive(join(dir, name), base);
      results.push(...children);
    } else {
      results.push(rel);
    }
  }
  return results;
}

function parseGitignorePrefixes(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

function isIgnoredByGitignore(rel: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    const normalized = prefix.endsWith('/') ? prefix : prefix;
    if (rel === normalized || rel.startsWith(`${normalized}/`) || rel.startsWith(normalized)) {
      return true;
    }
  }
  return false;
}

export async function collectTrackedFiles(projectDir: string): Promise<string[]> {
  let gitignorePrefixes: string[] = [];
  try {
    const gitignoreContent = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    gitignorePrefixes = parseGitignorePrefixes(gitignoreContent);
  } catch {
    // No .gitignore — that's fine
  }

  const allFiles = await readdirRecursive(projectDir, projectDir);
  const filtered = allFiles.filter(rel => !isIgnoredByGitignore(rel, gitignorePrefixes));
  filtered.sort();
  return filtered;
}

const STALE_LOCK_MS = 60_000;

export async function acquireSnapshotLock(
  projectDir: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  const lockPath = snapshotLockPath(projectDir, sessionId);
  const dir = snapshotsDir(projectDir, sessionId);
  ensureSecureDir(dir);

  const tryAcquire = (isRetry: boolean): void => {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        if (!isRetry) {
          let mtime: number;
          try {
            mtime = statSync(lockPath).mtimeMs;
          } catch {
            throw new Error('Another snapshot operation is in progress for this session.');
          }
          if (Date.now() - mtime > STALE_LOCK_MS) {
            try {
              unlinkSync(lockPath);
            } catch {
              // Already removed by another process
            }
            tryAcquire(true);
            return;
          }
        }
        throw new Error('Another snapshot operation is in progress for this session.');
      }
      throw err;
    }
  };

  tryAcquire(false);

  return async () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed
    }
  };
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

export type CreateSnapshotOptions = {
  projectDir: string;
  sessionId: string;
  phase: SnapshotPhase;
  name?: string;
  taskIndex?: number;
  bus?: EventBus;
  eventPhase?: Phase;
};

export type CreateSnapshotResult = {
  manifest: SnapshotManifest;
  snapshotDir: string;
  isFirstSnapshot: boolean;
};

export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  const { projectDir, sessionId, phase, name, taskIndex, bus, eventPhase } = opts;
  const release = await acquireSnapshotLock(projectDir, sessionId);
  let result: CreateSnapshotResult;
  try {
    const trackedPaths = await collectTrackedFiles(projectDir);

    if (!(await hasBaseline(projectDir, sessionId))) {
      const filesDir = join(baselineDir(projectDir, sessionId), 'files');
      await mkdir(filesDir, { recursive: true });

      const fileHashes: Record<string, string> = {};
      const fileEntries: SnapshotFileEntry[] = [];

      for (const path of trackedPaths) {
        const hash = (await hashFile(join(projectDir, path))) ?? '';
        fileHashes[path] = hash;
        const encodedName = encodeSnapshotPath(path);
        const absPath = join(projectDir, path);
        let sizeBytes = 0;
        try {
          const contents = await readFile(absPath);
          sizeBytes = contents.length;
          await writeFile(join(filesDir, encodedName), contents, { mode: SECURE_FILE_MODE });
        } catch {
          // File may be unreadable — skip writing but still record it
        }
        fileEntries.push({ path, hash, encodedName, sizeBytes });
      }

      const manifest: SnapshotManifest = {
        version: 1,
        id: SNAPSHOT_BASELINE_ID,
        sessionId,
        createdAt: new Date().toISOString(),
        phase,
        fileHashes,
        fileEntries,
        trackedFileCount: trackedPaths.length,
        ...(name !== undefined && { name }),
        ...(taskIndex !== undefined && { taskIndex }),
      };

      await writeManifest(projectDir, sessionId, manifest);
      result = {
        manifest,
        snapshotDir: baselineDir(projectDir, sessionId),
        isFirstSnapshot: true,
      };
    } else {
      const baselineManifest = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
      const baselineHashes = new Map(Object.entries(baselineManifest.fileHashes));

      const id = generateSnapshotId();
      const filesDir = snapshotFilesDir(projectDir, sessionId, id);
      await mkdir(filesDir, { recursive: true });

      const fileHashes: Record<string, string> = {};
      const fileEntries: SnapshotFileEntry[] = [];

      for (const path of trackedPaths) {
        const hash = (await hashFile(join(projectDir, path))) ?? '';
        fileHashes[path] = hash;

        if (hash !== (baselineHashes.get(path) ?? '')) {
          const encodedName = encodeSnapshotPath(path);
          const absPath = join(projectDir, path);
          let sizeBytes = 0;
          try {
            const contents = await readFile(absPath);
            sizeBytes = contents.length;
            await writeFile(join(filesDir, encodedName), contents, { mode: SECURE_FILE_MODE });
          } catch {
            // File may be unreadable — skip writing but still record in entries
          }
          fileEntries.push({ path, hash, encodedName, sizeBytes });
        }
      }

      const manifest: SnapshotManifest = {
        version: 1,
        id,
        sessionId,
        createdAt: new Date().toISOString(),
        phase,
        fileHashes,
        fileEntries,
        trackedFileCount: trackedPaths.length,
        ...(name !== undefined && { name }),
        ...(taskIndex !== undefined && { taskIndex }),
      };

      await writeManifest(projectDir, sessionId, manifest);
      result = {
        manifest,
        snapshotDir: snapshotDir(projectDir, sessionId, id),
        isFirstSnapshot: false,
      };
    }
  } finally {
    await release();
  }

  if (bus && eventPhase !== undefined) {
    bus.publish({
      type: 'snapshot_created',
      ts: Date.now(),
      phase: eventPhase,
      snapshotId: result.manifest.id,
      fileCount: result.manifest.trackedFileCount,
      ...(name !== undefined && { name }),
      ...(taskIndex !== undefined && { taskIndex }),
    });
  }

  return result;
}

export type ListSnapshotsResult = {
  manifests: SnapshotManifest[];
};

export async function listSnapshots(
  projectDir: string,
  sessionId: string,
): Promise<ListSnapshotsResult> {
  const ids = await listSnapshotIds(projectDir, sessionId);
  const manifests: SnapshotManifest[] = [];
  for (const id of ids) {
    if (id === SNAPSHOT_BASELINE_ID) continue;
    try {
      const manifest = await readManifest(projectDir, sessionId, id);
      manifests.push(manifest);
    } catch {
      console.warn(`Skipping corrupted snapshot manifest: ${id}`);
    }
  }
  manifests.sort((a, b) => a.id.localeCompare(b.id));
  return { manifests };
}
