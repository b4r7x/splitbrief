import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ansis from 'ansis';
import { readFileSafeAsync } from '../../lib/fs.js';
import { isENOENT } from '../../lib/process/errors.js';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { snapshotFilesDir, SNAPSHOT_BASELINE_ID } from '../../core/paths.js';
import {
  collectTrackedFiles,
  hashFile,
  readManifest,
} from './store.js';

export type FileDiff = {
  path: string;
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  diff?: string;
};

export type SnapshotDiffResult = {
  snapshotId: string;
  createdAt: string;
  files: FileDiff[];
  changedCount: number;
};

export type DiffOptions = {
  projectDir: string;
  sessionId: string;
  manifest: SnapshotManifest;
  paths?: string[];
};

const execFileAsync = promisify(execFile);

function execFileFailure(err: unknown): { code: number | null; stdout: string | null } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, stdout } = err as { code?: unknown; stdout?: unknown };
  return {
    code: typeof code === 'number' ? code : null,
    stdout: typeof stdout === 'string' ? stdout : null,
  };
}

function manualTwoPassDiff(snapshotContent: string, currentContent: string, path: string): string {
  const snapshotLines = snapshotContent.split('\n');
  const currentLines = currentContent.split('\n');
  const header = `--- snapshot/${path}\n+++ current/${path}\n@@ -1,${snapshotLines.length} +1,${currentLines.length} @@\n`;
  const removed = snapshotLines.map(l => `-${l}`).join('\n');
  const added = currentLines.map(l => `+${l}`).join('\n');
  return `${header}${removed}\n${added}\n`;
}

async function readBothFiles(snapshotFile: string, currentFile: string): Promise<[string, string] | null> {
  const [snapshotContent, currentContent] = await Promise.all([
    readFileSafeAsync(snapshotFile),
    readFileSafeAsync(currentFile),
  ]);
  if (snapshotContent === null || currentContent === null) return null;
  return [snapshotContent, currentContent];
}

async function fallbackDiff(snapshotFile: string, currentFile: string, path: string): Promise<string> {
  const pair = await readBothFiles(snapshotFile, currentFile);
  if (pair === null) return '';
  return manualTwoPassDiff(pair[0], pair[1], path);
}

async function unifiedDiff(snapshotFile: string, currentFile: string, path: string): Promise<string> {
  if (process.platform === 'win32') {
    return fallbackDiff(snapshotFile, currentFile, path);
  }

  try {
    const result = await execFileAsync('diff', [
      '-u',
      '--label', `snapshot/${path}`,
      '--label', `current/${path}`,
      snapshotFile,
      currentFile,
    ]);
    return result.stdout ?? '';
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return fallbackDiff(snapshotFile, currentFile, path);
    }
    // diff exits 1 when files differ (normal), 2+ on error
    const failure = execFileFailure(err);
    if (failure !== null && failure.code === 1) {
      return failure.stdout ?? '';
    }
    return fallbackDiff(snapshotFile, currentFile, path);
  }
}

export async function computeSnapshotDiff(opts: DiffOptions): Promise<SnapshotDiffResult> {
  const { projectDir, sessionId, manifest } = opts;

  const baselineManifest = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);

  const allSnapshotPaths = new Set(Object.keys(manifest.fileHashes));
  const currentPaths = await collectTrackedFiles(projectDir);
  const union = new Set([...allSnapshotPaths, ...currentPaths]);

  const requestedPaths = opts.paths;
  const filteredPaths = requestedPaths !== undefined
    ? [...union].filter(p => requestedPaths.includes(p))
    : [...union];

  const deltaEntryMap = new Map(manifest.fileEntries.map(e => [e.path, e]));
  const baselineEntryMap = new Map(baselineManifest.fileEntries.map(e => [e.path, e]));

  const files: FileDiff[] = [];

  for (const path of filteredPaths) {
    const inSnapshot = manifest.fileHashes[path] !== undefined;
    const currentHash = await hashFile(join(projectDir, path));
    const snapshotHash = manifest.fileHashes[path] ?? null;

    if (!inSnapshot && currentHash !== null) {
      files.push({ path, status: 'added' });
      continue;
    }

    if (inSnapshot && currentHash === null) {
      files.push({ path, status: 'removed' });
      continue;
    }

    if (snapshotHash === currentHash) {
      files.push({ path, status: 'unchanged' });
      continue;
    }

    let snapshotFilePath: string;
    const deltaEntry = deltaEntryMap.get(path);
    if (deltaEntry !== undefined) {
      snapshotFilePath = join(snapshotFilesDir(projectDir, sessionId, manifest.id), deltaEntry.encodedName);
    } else {
      const baselineEntry = baselineEntryMap.get(path);
      if (baselineEntry === undefined) {
        files.push({ path, status: 'modified' });
        continue;
      }
      snapshotFilePath = join(snapshotFilesDir(projectDir, sessionId, SNAPSHOT_BASELINE_ID), baselineEntry.encodedName);
    }

    const currentFilePath = join(projectDir, path);
    const diff = await unifiedDiff(snapshotFilePath, currentFilePath, path);
    files.push({ path, status: 'modified', diff });
  }

  const changedCount = files.filter(f => f.status !== 'unchanged').length;

  return { snapshotId: manifest.id, createdAt: manifest.createdAt, files, changedCount };
}

export function formatSnapshotDiff(result: SnapshotDiffResult, opts?: { color?: boolean }): string {
  const useColor = opts?.color !== false;
  const lines: string[] = [];

  const header = `Snapshot: ${result.snapshotId}  (${result.createdAt})`;
  lines.push(useColor ? ansis.dim(header) : header);

  if (result.changedCount === 0) {
    lines.push(`No differences from snapshot ${result.snapshotId}.`);
    return lines.join('\n');
  }

  for (const file of result.files) {
    if (file.status === 'unchanged') continue;

    if (file.status === 'modified') {
      if (file.diff) {
        lines.push(file.diff);
      } else {
        lines.push(`modified: ${file.path}`);
      }
    } else if (file.status === 'added') {
      const text = `+++ ${file.path}  (added after snapshot)`;
      lines.push(useColor ? ansis.cyan(text) : text);
    } else if (file.status === 'removed') {
      const text = `--- ${file.path}  (removed after snapshot)`;
      lines.push(useColor ? ansis.cyan(text) : text);
    }
  }

  const modified = result.files.filter(f => f.status === 'modified').length;
  const added = result.files.filter(f => f.status === 'added').length;
  const removed = result.files.filter(f => f.status === 'removed').length;
  const summary = `${result.changedCount} file(s) changed (modified: ${modified}, added: ${added}, removed: ${removed})`;
  lines.push(useColor ? ansis.dim(summary) : summary);

  return lines.join('\n');
}
