import { rmSync } from 'node:fs';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DIPTYCH_DIR, TREES_DIR } from '../../../core/paths.js';
import { warnStderr } from '../../../lib/warn.js';
import { getChangedFilesSnapshot } from './file-snapshots.js';
import type { ChangedFilesSnapshot, FileContentSnapshot } from './file-snapshots.js';
import { readCurrentFileContent, writeCurrentFileContent } from './file-snapshots.js';

export type StagedProject = {
  projectDir: string;
  snapshot: ChangedFilesSnapshot;
  cleanup: () => void;
};

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
};

const STAGED_COPY_EXCLUDE = new Set([
  'node_modules',
  DIPTYCH_DIR,
  TREES_DIR,
  '.env',
]);

function isStagedCopyExcluded(name: string): boolean {
  if (STAGED_COPY_EXCLUDE.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  return false;
}

export async function createStagedProject(projectDir: string): Promise<StagedProject> {
  const snapshot = await getChangedFilesSnapshot(projectDir);
  const stagedRoot = await mkdtemp(join(tmpdir(), 'diptych-stage-'));
  warnStderr(`Staged project temp root: ${stagedRoot}`);
  const stagedProjectDir = join(stagedRoot, basename(projectDir));
  await cp(projectDir, stagedProjectDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !isStagedCopyExcluded(basename(source)),
  });
  return {
    projectDir: stagedProjectDir,
    snapshot,
    cleanup: () => {
      rmSync(stagedRoot, { recursive: true, force: true });
    },
  };
}

export async function promoteStagedChanges(
  projectDir: string,
  stagedProjectDir: string,
  files: string[],
  expectedCurrentContents: FileContentSnapshot,
): Promise<PromoteStagedChangesResult> {
  const promotedFiles: string[] = [];
  const conflictResults = await Promise.all(
    files.map(async (file): Promise<string | null> => {
      if (!Object.hasOwn(expectedCurrentContents, file)) return null;
      return (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file] ? file : null;
    }),
  );
  const conflictedFiles = conflictResults.filter((f): f is string => f !== null);

  if (conflictedFiles.length > 0) {
    return { promotedFiles, conflictedFiles };
  }

  for (const file of files) {
    await writeCurrentFileContent(projectDir, file, await readCurrentFileContent(stagedProjectDir, file));
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles };
}
