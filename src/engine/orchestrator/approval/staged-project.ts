import { rmSync } from 'node:fs';
import { cp, lstat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { INTERNAL_SKIP_DIRS } from '../../../core/paths.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { createSandboxEnv, runnerAuthEnvKeys } from '../../runners/sandbox-env.js';
import { captureProjectFileHashes, getChangedFilesSnapshot } from './file-snapshots/capture.js';
import type { ChangedFilesSnapshot, FileContentSnapshot } from './file-snapshots/types.js';
import { readCurrentFileContent, writeCurrentFileContent } from './file-snapshots/contents.js';

export type StagedProject = {
  projectDir: string;
  sandboxEnv: NodeJS.ProcessEnv;
  snapshot: ChangedFilesSnapshot;
  cleanup: () => void;
};

export type StagedProjectRunnerRole = 'planner' | 'implementer';

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
};

const STAGED_COPY_EXCLUDE = new Set([
  ...INTERNAL_SKIP_DIRS,
  '.env',
  '.npmrc',
  '.netrc',
  '.git-credentials',
]);

function isStagedCopyExcluded(name: string): boolean {
  if (STAGED_COPY_EXCLUDE.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  return false;
}

async function shouldCopyToStagedProject(source: string): Promise<boolean> {
  if (isStagedCopyExcluded(basename(source))) return false;
  return !(await lstat(source)).isSymbolicLink();
}

export async function createStagedProject(
  projectDir: string,
  config?: Config,
  runnerRole: StagedProjectRunnerRole = 'implementer',
): Promise<StagedProject> {
  const snapshot = await getChangedFilesSnapshot(projectDir);
  const stagedRoot = await mkdtemp(join(tmpdir(), 'diptych-stage-'));
  try {
    const stagedProjectDir = join(stagedRoot, basename(projectDir));
    await cp(projectDir, stagedProjectDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: shouldCopyToStagedProject,
    });
    const baselineFileHashes = await captureProjectFileHashes(stagedProjectDir, {
      ignoreProjectDir: projectDir,
    });
    const preserveEnvKeys = config ? runnerAuthEnvKeys(config[runnerRole]) : [];
    const sandboxEnv = await createSandboxEnv(stagedProjectDir, preserveEnvKeys);
    return {
      projectDir: stagedProjectDir,
      sandboxEnv,
      snapshot: { ...snapshot, baselineFileHashes, ignoreProjectDir: projectDir },
      cleanup: () => {
        rmSync(stagedRoot, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(stagedRoot, { recursive: true, force: true });
    throw err;
  }
}

export async function promoteStagedChanges(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  files: string[];
  expectedCurrentContents: FileContentSnapshot;
}): Promise<PromoteStagedChangesResult> {
  const { targetProjectDir, stagedProjectDir, files, expectedCurrentContents } = opts;
  const promotedFiles: string[] = [];
  for (const file of files) {
    assertPathConfined(file, targetProjectDir);
    assertPathConfined(file, stagedProjectDir);
  }
  const conflictResults = await Promise.all(
    files.map(async (file): Promise<string | null> => {
      if (!Object.hasOwn(expectedCurrentContents, file)) return null;
      return (await readCurrentFileContent(targetProjectDir, file)) !==
        expectedCurrentContents[file]
        ? file
        : null;
    }),
  );
  const conflictedFiles = conflictResults.filter((f): f is string => f !== null);

  if (conflictedFiles.length > 0) {
    return { promotedFiles, conflictedFiles };
  }

  for (const file of files) {
    await writeCurrentFileContent(
      targetProjectDir,
      file,
      await readCurrentFileContent(stagedProjectDir, file),
    );
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles };
}
