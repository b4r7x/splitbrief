import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ansis from 'ansis';
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

function manualTwoPassDiff(snapshotContent: string, currentContent: string, path: string): string {
  const snapshotLines = snapshotContent.split('\n');
  const currentLines = currentContent.split('\n');
  const header = `--- snapshot/${path}\n+++ current/${path}\n@@ -1,${snapshotLines.length} +1,${currentLines.length} @@\n`;
  const removed = snapshotLines.map(l => `-${l}`).join('\n');
  const added = currentLines.map(l => `+${l}`).join('\n');
  return `${header}${removed}\n${added}\n`;
}

function unifiedDiff(snapshotFile: string, currentFile: string, path: string): string {
  if (process.platform === 'win32') {
    const snapshotContent = tryReadFileSync(snapshotFile);
    const currentContent = tryReadFileSync(currentFile);
    if (snapshotContent === null || currentContent === null) return '';
    return manualTwoPassDiff(snapshotContent, currentContent, path);
  }

  const result = spawnSync('diff', [
    '-u',
    '--label', `snapshot/${path}`,
    '--label', `current/${path}`,
    snapshotFile,
    currentFile,
  ]);

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      const snapshotContent = tryReadFileSync(snapshotFile);
      const currentContent = tryReadFileSync(currentFile);
      if (snapshotContent === null || currentContent === null) return '';
      return manualTwoPassDiff(snapshotContent, currentContent, path);
    }
    return '';
  }

  if (result.status === null || result.status >= 2) {
    const snapshotContent = tryReadFileSync(snapshotFile);
    const currentContent = tryReadFileSync(currentFile);
    if (snapshotContent === null || currentContent === null) return '';
    return manualTwoPassDiff(snapshotContent, currentContent, path);
  }

  return result.stdout?.toString() ?? '';
}

function tryReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
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
    const diff = unifiedDiff(snapshotFilePath, currentFilePath, path);
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
