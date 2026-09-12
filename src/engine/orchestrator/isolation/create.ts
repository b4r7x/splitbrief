import { realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isInternalGitStatusPath } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { createGitClient, type GitClient } from '../../../lib/git/client.js';
import { getCurrentChangedFiles } from '../../../lib/git/files.js';
import { hasCommits, isGitRepo } from '../../../lib/git/repository.js';
import { warnError } from '../../../lib/warn.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import {
  createRunnerSandboxEnv,
  pruneSandboxNpmCache,
  runnerSandboxIdentity,
  withPrependedPathDirectory,
} from '../../runners/sandbox-env.js';
import { clearBridgedCliState } from '../../runners/sandbox-state-bridge.js';
import { removeWorktree } from './remove-worktree.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { readCurrentFileContent } from '../approval/file-snapshots/contents.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { createStagedProject, stripGitignoreBookkeeping } from '../approval/staged-project.js';
import type { IsolationRole, IsolatedWorkspace, RunIsolation } from './types.js';
import { ensureIsolationWorktree, removeNodeModulesExclude } from './worktree.js';

const NODE_MODULES = 'node_modules';

// The worktree's parent under the isolation trees root is this repository's
// directory, shared by every session of it, so the removal only succeeds once
// this run's worktree was the last entry: a concurrent session's worktree makes
// it fail with ENOTEMPTY and the directory stays. Without it, the user state
// directory collects one empty directory per repository ever run in.
async function removeEmptyRepositoryRoot(worktreeDir: string): Promise<void> {
  try {
    await rmdir(dirname(worktreeDir));
  } catch {
    return;
  }
}

function gitignoresMatch(a: string | null, b: string | null): boolean {
  return stripGitignoreBookkeeping(a) === stripGitignoreBookkeeping(b);
}

export function createRunIsolation(opts: {
  projectDir: string;
  sessionId: string;
  strategy: IsolationStrategy;
  onFallback: (reason: string) => void;
  onRetained: (dir: string) => void;
  warningPublisher?: (message: string) => void;
}): RunIsolation {
  const { projectDir, sessionId, strategy, onFallback, onRetained, warningPublisher } = opts;

  let latchedStrategy: IsolationStrategy = strategy;
  let fallbackReported = false;
  let worktreeDir: string | null = null;
  let worktreeGit: GitClient | null = null;
  let createdWorktreeDir: string | null = null;
  let nodeModulesExcludeFile: string | null = null;
  let worktreeAbandoned = false;
  // The worktree's content right after creation and seeding. Seeded files track
  // live project files (the operator's own log of this run, for one), so the
  // dispose scan must only weigh files the run changed on top of this baseline —
  // comparing a stale seed against a project file that moved on would retain a
  // fully promoted worktree forever.
  let seedSnapshot: ChangedFilesSnapshot | null = null;
  let worktreePromise: Promise<string | null> | null = null;
  // A worktree cleanup is asynchronous while its callers are not, so the work is
  // chained here and awaited by everything that reads the worktree afterwards.
  let pendingCleanup: Promise<void> = Promise.resolve();
  // createRunnerSandboxEnv re-bridges the runner's own host CLI state on every
  // call, so an env is built once per runner and reused for the rest of the run.
  const envMemo = new Map<string, Promise<NodeJS.ProcessEnv>>();

  function reportFallback(reason: string): void {
    if (fallbackReported) return;
    fallbackReported = true;
    onFallback(reason);
    latchedStrategy = 'staged-copy';
  }

  function resolveWorktreeDir(): Promise<string | null> {
    if (worktreePromise === null) {
      worktreePromise = (async (): Promise<string | null> => {
        if (!(await isGitRepo(projectDir))) {
          reportFallback('project is not a git repository');
          return null;
        }
        if (!(await hasCommits(projectDir))) {
          reportFallback('repository has no commits');
          return null;
        }
        const git = createGitClient(projectDir);
        try {
          const result = await ensureIsolationWorktree({
            projectDir,
            sessionId,
            git,
            onWorktreeCreated: (path) => {
              createdWorktreeDir = path;
            },
            onNodeModulesExcluded: (file) => {
              nodeModulesExcludeFile = file;
            },
          });
          if (result.kind === 'fallback') {
            worktreeDir = createdWorktreeDir;
            worktreeGit = git;
            worktreeAbandoned = true;
            reportFallback(result.reason);
            return null;
          }
          worktreeGit = git;
          worktreeDir = result.worktreePath;
          if (!result.reused) {
            seedSnapshot = await getChangedFilesSnapshot(result.worktreePath);
          }
          return result.worktreePath;
        } catch (err) {
          worktreeDir = createdWorktreeDir;
          worktreeGit = git;
          worktreeAbandoned = true;
          reportFallback(toErrorMessage(err));
          return null;
        }
      })();
    }
    return worktreePromise;
  }

  function sandboxEnvFor(
    dir: string,
    role: IsolationRole,
    config: Config,
  ): Promise<NodeJS.ProcessEnv> {
    const runner = config[role];
    // The role reaches createRunnerSandboxEnv so each one bridges into its own
    // <worktree>/.splitbrief/sandbox/<role>: a role's acquisition clears only
    // what it bridged, never the snapshot the other role's memoised env is still
    // pointed at. envMemo is keyed on the runner too, so a task profile
    // overriding config.implementer gets its own rather than the first runner's
    // auth-key allowlist and bridged tool.
    const key = `${dir}\u0000${role}\u0000${runnerSandboxIdentity(runner)}`;
    let env = envMemo.get(key);
    if (env === undefined) {
      env = createRunnerSandboxEnv(dir, runner, role);
      envMemo.set(key, env);
    }
    return env;
  }

  async function workspaceSandboxEnv(
    dir: string,
    role: IsolationRole,
    config: Config,
  ): Promise<NodeJS.ProcessEnv> {
    const env = await sandboxEnvFor(dir, role, config);
    let binDir: string;
    try {
      binDir = await realpath(join(dir, NODE_MODULES, '.bin'));
    } catch {
      return env;
    }
    return withPrependedPathDirectory(env, binDir);
  }

  async function isUnpromoted(worktreePath: string, file: string): Promise<boolean> {
    if (file.endsWith('/')) return false;
    if (isInternalGitStatusPath(file)) return false;
    const worktreeContent = await readCurrentFileContent(worktreePath, file);
    const projectContent = await readCurrentFileContent(projectDir, file);
    if (file === '.gitignore') return !gitignoresMatch(worktreeContent, projectContent);
    return worktreeContent !== projectContent;
  }

  // Every task in the run shares one worktree, so a cleanup reverts only what
  // this acquisition changed, and only where the project never received it:
  // promoted work stays, because the tasks after it work on top of it. Anything
  // a revert fails to discard is reported by dispose's retention scan.
  function queueWorktreeCleanup(dir: string, snapshot: ChangedFilesSnapshot): void {
    pendingCleanup = pendingCleanup
      .then(async () => {
        const changed = await getChangedFilesSinceSnapshot(dir, snapshot);
        const results = await Promise.all(
          changed.map(async (file) => ((await isUnpromoted(dir, file)) ? file : null)),
        );
        const discarded = results.filter((file): file is string => file !== null);
        await restoreDirtyFilesFromSnapshot(dir, snapshot, discarded);
      })
      .catch((err) => {
        warnError(`Isolation cleanup failed for session ${sessionId} at ${dir}`, err);
      });
  }

  async function acquire(opts: {
    role: IsolationRole;
    config: Config;
    writesFiles: 'direct' | 'extracted-code';
  }): Promise<IsolatedWorkspace> {
    const { role, config, writesFiles } = opts;
    const dir =
      writesFiles === 'extracted-code' || latchedStrategy === 'staged-copy'
        ? null
        : await resolveWorktreeDir();
    if (dir === null) {
      return {
        ...(await createStagedProject(projectDir, config, role)),
        changeDetection: 'file-hashes',
      };
    }
    await pendingCleanup;
    const snapshot = await getChangedFilesSnapshot(dir);
    return {
      projectDir: dir,
      sandboxEnv: await workspaceSandboxEnv(dir, role, config),
      snapshot,
      changeDetection: 'file-hashes',
      cleanup: () => queueWorktreeCleanup(dir, snapshot),
    };
  }

  // A reused worktree (a resumed session) has no seed baseline in this process,
  // so every changed file is scanned; retention can only err towards keeping it.
  async function hasUnpromotedWork(worktreePath: string): Promise<boolean> {
    const changed =
      seedSnapshot === null
        ? await getCurrentChangedFiles(worktreePath)
        : await getChangedFilesSinceSnapshot(worktreePath, seedSnapshot);
    for (const file of changed) {
      if (await isUnpromoted(worktreePath, file)) return true;
    }
    return false;
  }

  async function dispose(): Promise<void> {
    try {
      await pendingCleanup;
      // The planner never takes the worktree — it runs in the project itself —
      // so the cache that survives a run is the one under the project's sandbox
      // roots, whatever isolation strategy the run ended up on. The worktree's
      // own cache goes with the worktree below.
      await pruneSandboxNpmCache(projectDir);
      const dir = worktreeDir;
      if (dir === null || worktreeGit === null) return;
      await clearBridgedCliState(dir);
      // A worktree the run fell back from was created before the fallback and was
      // never handed to an implementer, so it holds nothing to salvage and is
      // removed outright rather than scanned for unpromoted work.
      let promotionProven = false;
      if (!worktreeAbandoned) {
        try {
          promotionProven = !(await hasUnpromotedWork(dir));
          if (!promotionProven) {
            onRetained(dir);
            return;
          }
        } catch (err) {
          // Never delete on a failed scan: the worktree may hold unpromoted work
          // we could not see. Leave it for the next run's marker check to fall
          // back around.
          warnError(
            `Isolation worktree scan failed for session ${sessionId} at ${dir}; retaining it`,
            err,
          );
          return;
        }
      }
      await removeWorktree({
        projectDir,
        slug: basename(dir),
        git: worktreeGit,
        deleteBranch: true,
        worktreeDir: dir,
        ...(warningPublisher !== undefined && { warningPublisher }),
        suppressUncommittedWarning: promotionProven,
      });
      await removeEmptyRepositoryRoot(dir);
    } finally {
      // The entry lives in the repository's shared info/exclude, which the source
      // checkout reads too, so the run owns it only while it is running. It goes
      // last: the retention scan above reads the worktree's git status, and this
      // entry is what keeps the dependency link out of it.
      if (nodeModulesExcludeFile !== null) {
        await removeNodeModulesExclude(nodeModulesExcludeFile, sessionId);
      }
    }
  }

  return { acquire, dispose };
}
