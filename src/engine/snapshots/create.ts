import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  SnapshotFileEntry,
  SnapshotManifest,
  SnapshotPhase,
} from '../../core/schemas/snapshot.js';
import {
  baselineDir,
  snapshotDir,
  snapshotFilesDir,
  SNAPSHOT_BASELINE_ID,
} from '../../core/paths.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { acquireSnapshotLock } from './lock.js';
import { collectTrackedFiles, hashFile } from './files.js';
import { encodeSnapshotPath, generateSnapshotId } from './path-codec.js';
import { hasBaseline, readManifest, writeManifest } from './manifest.js';
import { nowIso } from '../../utils/format-time.js';

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

async function captureFile(opts: {
  projectDir: string;
  path: string;
  filesDir: string;
  force: boolean;
  baselineHash?: string | undefined;
}): Promise<{ hash: string; entry?: SnapshotFileEntry }> {
  const { projectDir, path, filesDir, force, baselineHash } = opts;
  assertExistingPathConfined(path, projectDir);
  const hash = (await hashFile(join(projectDir, path))) ?? '';
  if (!force && hash === (baselineHash ?? '')) {
    return { hash };
  }
  const encodedName = encodeSnapshotPath(path);
  const absPath = join(projectDir, path);

  let contents: Buffer;
  try {
    contents = await readFile(absPath);
  } catch {
    // Read failure (unreadable/removed source). The path stays tracked via its
    // hash, but no blob is written and no entry is recorded — restore reports it
    // as a missing snapshot file rather than reading a blob that never existed.
    return { hash };
  }

  // Write failure means snapshot storage is broken; propagating fails the whole
  // snapshot instead of silently recording an entry whose blob is absent.
  const blobPath = join(filesDir, encodedName);
  assertWritablePathConfined(relative(projectDir, blobPath), projectDir);
  await writeFile(blobPath, contents, { mode: SECURE_FILE_MODE });

  return { hash, entry: { path, hash, encodedName } };
}

function buildManifest(opts: {
  id: string;
  sessionId: string;
  phase: SnapshotPhase;
  fileHashes: Record<string, string>;
  fileEntries: SnapshotFileEntry[];
  trackedFileCount: number;
  name?: string | undefined;
  taskIndex?: number | undefined;
}): SnapshotManifest {
  return {
    version: 1,
    id: opts.id,
    sessionId: opts.sessionId,
    createdAt: nowIso(),
    phase: opts.phase,
    fileHashes: opts.fileHashes,
    fileEntries: opts.fileEntries,
    trackedFileCount: opts.trackedFileCount,
    ...(opts.name !== undefined && { name: opts.name }),
    ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
  };
}

export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  const { projectDir, sessionId, phase, name, taskIndex, bus, eventPhase } = opts;
  const release = await acquireSnapshotLock(projectDir, sessionId);
  let result: CreateSnapshotResult;
  try {
    const trackedPaths = await collectTrackedFiles(projectDir);

    if (!(await hasBaseline(projectDir, sessionId))) {
      const filesDir = join(baselineDir({ projectDir, sessionId }), 'files');
      assertWritablePathConfined(relative(projectDir, filesDir), projectDir);
      await mkdir(filesDir, { recursive: true });
      assertWritablePathConfined(relative(projectDir, filesDir), projectDir);

      const fileHashes: Record<string, string> = {};
      const fileEntries: SnapshotFileEntry[] = [];

      for (const path of trackedPaths) {
        const captured = await captureFile({ projectDir, path, filesDir, force: true });
        fileHashes[path] = captured.hash;
        if (captured.entry) fileEntries.push(captured.entry);
      }

      const manifest = buildManifest({
        id: SNAPSHOT_BASELINE_ID,
        sessionId,
        phase,
        fileHashes,
        fileEntries,
        trackedFileCount: trackedPaths.length,
        name,
        taskIndex,
      });

      await writeManifest(projectDir, sessionId, manifest);
      result = {
        manifest,
        snapshotDir: baselineDir({ projectDir, sessionId }),
        isFirstSnapshot: true,
      };
    } else {
      const baselineManifest = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
      const baselineHashes = new Map(Object.entries(baselineManifest.fileHashes));

      const id = generateSnapshotId();
      const filesDir = snapshotFilesDir({ projectDir, sessionId }, id);
      assertWritablePathConfined(relative(projectDir, filesDir), projectDir);
      await mkdir(filesDir, { recursive: true });
      assertWritablePathConfined(relative(projectDir, filesDir), projectDir);

      const fileHashes: Record<string, string> = {};
      const fileEntries: SnapshotFileEntry[] = [];

      for (const path of trackedPaths) {
        const captured = await captureFile({
          projectDir,
          path,
          filesDir,
          force: false,
          baselineHash: baselineHashes.get(path),
        });
        fileHashes[path] = captured.hash;
        if (captured.entry) fileEntries.push(captured.entry);
      }

      const manifest = buildManifest({
        id,
        sessionId,
        phase,
        fileHashes,
        fileEntries,
        trackedFileCount: trackedPaths.length,
        name,
        taskIndex,
      });

      await writeManifest(projectDir, sessionId, manifest);
      result = {
        manifest,
        snapshotDir: snapshotDir({ projectDir, sessionId }, id),
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
