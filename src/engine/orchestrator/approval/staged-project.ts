import { rmSync } from 'node:fs';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DIPTYCH_DIR, TREES_DIR } from '../../../core/paths.js';
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

export async function createStagedProject(projectDir: string): Promise<StagedProject> {
  const snapshot = await getChangedFilesSnapshot(projectDir);
  const stagedRoot = await mkdtemp(join(tmpdir(), 'diptych-stage-'));
  const stagedProjectDir = join(stagedRoot, basename(projectDir));
  await cp(projectDir, stagedProjectDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const name = basename(source);
      return name !== 'node_modules' && name !== DIPTYCH_DIR && name !== TREES_DIR;
    },
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
