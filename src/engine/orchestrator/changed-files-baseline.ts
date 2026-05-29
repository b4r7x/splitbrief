import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCurrentChangedFiles } from '../../lib/git.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { matchesActionPattern } from './approval/action-classifier.js';
import type { Task } from '../../core/schemas/task.js';

export type ChangedFilesBaseline = Map<string, string>;

function isInternalDiptychArtifact(file: string): boolean {
  return file.startsWith(`${DIPTYCH_DIR}/`);
}

export function userVisibleChangedFiles(files: string[]): string[] {
  return files.filter((file) => !isInternalDiptychArtifact(file));
}

async function fingerprintChangedFile(projectDir: string, file: string): Promise<string> {
  try {
    const content = await readFile(join(projectDir, file));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'missing';
  }
}

export async function captureChangedFilesBaseline(
  projectDir: string,
  files?: string[],
): Promise<ChangedFilesBaseline> {
  const changedFiles = userVisibleChangedFiles(files ?? (await getCurrentChangedFiles(projectDir)));
  const entries = await Promise.all(
    changedFiles.map(
      async (file) => [file, await fingerprintChangedFile(projectDir, file)] as const,
    ),
  );
  return new Map(entries);
}

export async function changedFilesSinceBaseline(
  projectDir: string,
  baseline: ChangedFilesBaseline,
): Promise<string[]> {
  const currentFiles = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  const current = await captureChangedFilesBaseline(projectDir, currentFiles);
  return currentFiles.filter((file) => baseline.get(file) !== current.get(file));
}

export async function refreshChangedFilesBaseline(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  absorbedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const currentFiles = userVisibleChangedFiles(await getCurrentChangedFiles(opts.projectDir));
  const current = await captureChangedFilesBaseline(opts.projectDir, currentFiles);
  const next = new Map<string, string>();

  for (const file of currentFiles) {
    if (opts.absorbedFiles.has(file)) {
      const fingerprint = current.get(file);
      if (fingerprint !== undefined) next.set(file, fingerprint);
    } else {
      const previous = opts.baseline.get(file);
      if (previous !== undefined) next.set(file, previous);
    }
  }

  return next;
}

export async function inferTaskAcceptedChangedFiles(
  projectDir: string,
  task: Task,
): Promise<string[]> {
  const patterns = [
    task.file,
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];
  const changedFiles = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  return changedFiles.filter((file) =>
    patterns.some((pattern) => matchesActionPattern(file, pattern)),
  );
}
