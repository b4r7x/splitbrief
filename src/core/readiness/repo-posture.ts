import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getGitStatus } from '../../lib/git/files.js';
import { getCurrentBranch } from '../../lib/git/refs.js';
import { isGitRepo, hasCommits, getInProgressGitOp } from '../../lib/git/repository.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from '../gitignore-bookkeeping.js';
import { isInternalGitStatusPath } from '../paths.js';
import { readPackageJson } from '../project-meta.js';
import { readActive } from '../sessions/active-pointer.js';
import { isSessionLive } from '../sessions/liveness.js';
import type { SessionRef } from '../types/session-ref.js';
import type { RepoReadinessInput } from './checks/repo.js';
import type { PackageScriptsReadinessInput } from './checks/validation.js';

export function readPackageScripts(projectDir: string): PackageScriptsReadinessInput {
  const packageJsonPath = join(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { packageJsonExists: false, scripts: {} };
  }

  try {
    const parsed: unknown = readPackageJson(projectDir, { throwOnInvalid: true });
    if (!isRecord(parsed)) {
      return {
        packageJsonExists: true,
        scripts: {},
        parseError: 'package.json root is not an object.',
      };
    }
    const scripts: unknown = parsed['scripts'];
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      return { packageJsonExists: true, scripts: {} };
    }
    const entries = Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return { packageJsonExists: true, scripts: Object.fromEntries(entries) };
  } catch (err) {
    return {
      packageJsonExists: true,
      scripts: {},
      parseError: toErrorMessage(err),
    };
  }
}

export async function readRepoPosture(
  projectDir: string,
  resumeSession?: SessionRef | undefined,
): Promise<RepoReadinessInput> {
  const repoExists = await isGitRepo(projectDir).catch(() => false);
  if (!repoExists) {
    return {
      isGitRepo: false,
      hasCommits: false,
      dirtyFiles: [],
      untrackedFiles: [],
    };
  }

  const repoHasCommits = await hasCommits(projectDir).catch(() => false);
  if (!repoHasCommits) {
    return {
      isGitRepo: true,
      hasCommits: false,
      dirtyFiles: [],
      untrackedFiles: [],
    };
  }

  const status = await getGitStatus(projectDir);
  const untracked = new Set(status.not_added);
  // The dirty-worktree check is about the operator's own edits. SPLITBRIEF's
  // state directory, old `.trees/` directories and its own `.gitignore` lines can show up
  // in git status, so counting them would report the tool's own bookkeeping as local work
  // the run might overwrite. The run sets the same files apart from its pre-run changes.
  const gitignoreOnlyBookkeeping =
    status.files.some((file) => file.path === '.gitignore') &&
    (await gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir));
  const isOperatorChange = (path: string) =>
    !isInternalGitStatusPath(path) &&
    !shouldIgnoreWorktreeUncommittedPath(path, gitignoreOnlyBookkeeping);
  const dirtyFiles = status.files
    .map((file) => file.path)
    .filter((path) => !untracked.has(path) && isOperatorChange(path));
  const untrackedFiles = status.not_added.filter(isOperatorChange);
  const inProgressGitOp = await getInProgressGitOp(projectDir).catch(() => null);
  const onDetachedHead = (await getCurrentBranch(projectDir).catch(() => '')) === 'HEAD';
  const activeSession = readActive(projectDir);
  const activeSessionBelongsToResume =
    activeSession !== null &&
    resumeSession?.projectDir === projectDir &&
    resumeSession.sessionId === activeSession;

  return {
    isGitRepo: true,
    hasCommits: true,
    dirtyFiles,
    untrackedFiles,
    onDetachedHead,
    inProgressGitOp,
    ...(activeSession !== null &&
      !activeSessionBelongsToResume && {
        activeSession,
        activeSessionLive: isSessionLive({ projectDir: projectDir, sessionId: activeSession }),
      }),
  };
}
