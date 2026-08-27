import { rmSync, type Stats } from 'node:fs';
import { cp, copyFile, lstat, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { INTERNAL_SKIP_DIRS, SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { listTrackedAndUntrackedFiles } from '../../../lib/git/files.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { createRunnerSandboxEnv, createSandboxEnv } from '../../runners/sandbox-env.js';
import { captureProjectFileHashes, getChangedFilesSnapshot } from './file-snapshots/capture.js';
import type { FileContentSnapshot } from './file-snapshots/types.js';
import { readCurrentFileContent, writeCurrentFileContent } from './file-snapshots/contents.js';
import type { IsolationRole, IsolatedWorkspace } from '../isolation/types.js';

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
};

const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_BOOKKEEPING_LINES = new Set([`${SPLITBRIEF_DIR}/`, `${TREES_DIR}/`]);

// Isolation appends these entries to the worktree's own .gitignore, so a bookkeeping
// line the project's copy does not already carry is SPLITBRIEF's and never the task's.
export function stripGitignoreBookkeeping(
  text: string | null,
  projectText: string | null = null,
): string {
  if (text === null) return '';
  const projectLines = new Set((projectText ?? '').split('\n').map((line) => line.trim()));
  return text
    .split('\n')
    .filter((line) => {
      const entry = line.trim();
      return !GITIGNORE_BOOKKEEPING_LINES.has(entry) || projectLines.has(entry);
    })
    .join('\n');
}

const STAGED_COPY_EXCLUDE = new Set([
  ...INTERNAL_SKIP_DIRS,
  '.env',
  '.npmrc',
  '.netrc',
  '.git-credentials',
]);

function isStagedCopyExcluded(name: string): boolean {
  return STAGED_COPY_EXCLUDE.has(name) || name.startsWith('.env');
}

async function shouldCopyToStagedProject(source: string): Promise<boolean> {
  if (isStagedCopyExcluded(basename(source))) return false;
  return !(await lstat(source)).isSymbolicLink();
}

function shouldCopyGitListedEntry(entry: string): boolean {
  if (entry.endsWith('/')) return false;
  const firstSegment = entry.split('/')[0] ?? '';
  if (INTERNAL_SKIP_DIRS.includes(firstSegment)) return false;
  return !isStagedCopyExcluded(basename(entry));
}

async function lstatIfPresent(source: string): Promise<Stats | null> {
  try {
    return await lstat(source);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

async function copyProjectFiles(projectDir: string, stagedProjectDir: string): Promise<void> {
  const entries = await listTrackedAndUntrackedFiles(projectDir);
  if (entries === null) {
    await cp(projectDir, stagedProjectDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: shouldCopyToStagedProject,
    });
    return;
  }
  for (const entry of entries) {
    if (!shouldCopyGitListedEntry(entry)) continue;
    const source = join(projectDir, entry);
    const stats = await lstatIfPresent(source);
    if (stats === null || !stats.isFile()) continue;
    const target = join(stagedProjectDir, entry);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

export async function createStagedProject(
  projectDir: string,
  config?: Config,
  role: IsolationRole = 'implementer',
): Promise<IsolatedWorkspace> {
  const snapshot = await getChangedFilesSnapshot(projectDir);
  const stagedRoot = await mkdtemp(join(tmpdir(), `${SPLITBRIEF_IDENTITY.slug}-stage-`));
  try {
    const stagedProjectDir = join(stagedRoot, basename(projectDir));
    await copyProjectFiles(projectDir, stagedProjectDir);
    const baselineFileHashes = await captureProjectFileHashes(stagedProjectDir, {
      ignoreProjectDir: projectDir,
    });
    const sandboxEnv = config
      ? await createRunnerSandboxEnv(stagedProjectDir, config[role], role)
      : await createSandboxEnv({ projectDir: stagedProjectDir });
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

async function contentToPromote(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  file: string;
}): Promise<string | null> {
  const { targetProjectDir, stagedProjectDir, file } = opts;
  const staged = await readCurrentFileContent(stagedProjectDir, file);
  if (file !== GITIGNORE_FILE || staged === null) return staged;
  return stripGitignoreBookkeeping(staged, await readCurrentFileContent(targetProjectDir, file));
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
      await contentToPromote({ targetProjectDir, stagedProjectDir, file }),
    );
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles };
}
