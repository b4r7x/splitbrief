import { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { listWorktrees, removeWorktree } from '../../engine/git/worktree.js';
import type { WorktreeInfo } from '../../engine/git/worktree.js';

function statusCell(info: WorktreeInfo): string {
  return info.status;
}

function valueOrUnknown(value: string | null): string {
  return value ?? 'unknown';
}

function renderList(worktrees: WorktreeInfo[]): void {
  const terminalWidth = process.stdout.columns ?? 80;

  const NAME_MIN = 12;
  const PATH_MIN = 18;
  const BRANCH_MIN = 18;
  const STATUS_MIN = 10;
  const SESSION_MIN = 12;
  const PHASE_MIN = 10;
  const UPDATED_MIN = 12;

  const nameNatural = Math.max(NAME_MIN, 'NAME'.length, ...worktrees.map((w) => w.name.length));
  const pathNatural = Math.max(PATH_MIN, 'PATH'.length, ...worktrees.map((w) => w.path.length));
  const branchNatural = Math.max(
    BRANCH_MIN,
    'BRANCH'.length,
    ...worktrees.map((w) => w.branch.length),
  );
  const statusNatural = Math.max(
    STATUS_MIN,
    'STATUS'.length,
    ...worktrees.map((w) => statusCell(w).length),
  );
  const sessionNatural = Math.max(
    SESSION_MIN,
    'SESSION'.length,
    ...worktrees.map((w) => valueOrUnknown(w.sessionId).length),
  );
  const phaseNatural = Math.max(
    PHASE_MIN,
    'PHASE'.length,
    ...worktrees.map((w) => valueOrUnknown(w.phase).length),
  );
  const updatedNatural = Math.max(
    UPDATED_MIN,
    'UPDATED'.length,
    ...worktrees.map((w) => valueOrUnknown(w.lastUpdated).length),
  );

  const GAP = 2;
  const totalNatural =
    nameNatural +
    GAP +
    pathNatural +
    GAP +
    branchNatural +
    GAP +
    statusNatural +
    GAP +
    sessionNatural +
    GAP +
    phaseNatural +
    GAP +
    updatedNatural;

  let nameW = nameNatural;
  let pathW = pathNatural;
  let branchW = branchNatural;
  const statusW = statusNatural;
  const sessionW = sessionNatural;
  const phaseW = phaseNatural;
  const updatedW = updatedNatural;

  if (totalNatural > terminalWidth) {
    const overflow = totalNatural - terminalWidth;
    pathW = Math.max(PATH_MIN, pathNatural - overflow);
    const afterPath = nameW + GAP + pathW + GAP + branchW + GAP + statusW + GAP + sessionW + GAP + phaseW + GAP + updatedW;
    if (afterPath > terminalWidth) {
      branchW = Math.max(BRANCH_MIN, branchNatural - (afterPath - terminalWidth));
    }
    if (nameW + GAP + pathW + GAP + branchW + GAP + statusW + GAP + sessionW + GAP + phaseW + GAP + updatedW > terminalWidth) {
      nameW = Math.max(NAME_MIN, terminalWidth - GAP - pathW - GAP - branchW - GAP - statusW - GAP - sessionW - GAP - phaseW - GAP - updatedW);
    }
  }

  const header = [
    'NAME'.padEnd(nameW),
    'PATH'.padEnd(pathW),
    'BRANCH'.padEnd(branchW),
    'STATUS'.padEnd(statusW),
    'SESSION'.padEnd(sessionW),
    'PHASE'.padEnd(phaseW),
    'UPDATED'.padEnd(updatedW),
  ].join('  ');
  console.log(header);

  for (const w of worktrees) {
    const name = w.name.length > nameW ? w.name.slice(0, nameW) : w.name.padEnd(nameW);
    const path = w.path.length > pathW ? w.path.slice(0, pathW) : w.path.padEnd(pathW);
    const branch = w.branch.length > branchW ? w.branch.slice(0, branchW) : w.branch.padEnd(branchW);
    const status = statusCell(w);
    const session = valueOrUnknown(w.sessionId);
    const phase = valueOrUnknown(w.phase);
    const updated = valueOrUnknown(w.lastUpdated);
    console.log([name, path, branch, status, session, phase, updated].join('  '));
  }
}

export function registerWorktreeCommand(program: Command): void {
  const worktree = program
    .command('worktree')
    .description('Manage diptych-managed git worktrees');

  worktree
    .command('list')
    .description('List all diptych-managed worktrees')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const git = simpleGit(projectDir);
      const worktrees = await listWorktrees(projectDir, git);

      if (worktrees.length === 0) {
        console.log('No diptych-managed worktrees found.');
        return;
      }

      renderList(worktrees);
    });

  worktree
    .command('switch <name>')
    .description('Print instructions to switch to a worktree')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (name: string, opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const git = simpleGit(projectDir);
      const worktrees = await listWorktrees(projectDir, git);
      const found = worktrees.some((w) => w.name === name);

      if (!found) {
        throw cliError(`Worktree "${name}" not found.`, 1);
      }

      console.log(`To switch to worktree "${name}", run:`);
      console.log(`  cd .trees/${name}`);
      console.log('');
      console.log('Or add the following shell function to your profile:');
      console.log('  diptych-switch() { cd "$(diptych worktree path "$1")"; }');
    });

  worktree
    .command('remove <name>')
    .description('Remove a diptych-managed worktree')
    .option('--force', 'Bypass live-session and uncommitted-changes guards')
    .option('--delete-branch', 'Also delete the diptych/<name> branch')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(
      async (
        name: string,
        opts: { force?: boolean; deleteBranch?: boolean; project?: string },
      ) => {
        const projectDir = resolveProjectDir(opts.project);
        const git = simpleGit(projectDir);

        const worktrees = await listWorktrees(projectDir, git);
        const found = worktrees.some((w) => w.name === name);
        if (!found) {
          throw cliError(`Worktree "${name}" not found.`, 1);
        }

        try {
          await removeWorktree({
            projectDir,
            slug: name,
            git,
            force: opts.force ?? false,
            deleteBranch: opts.deleteBranch ?? false,
          });
        } catch (err) {
          throw cliError(toErrorMessage(err), 1);
        }

        console.log(`Removed worktree ".trees/${name}".`);
        if (opts.deleteBranch) {
          console.log(`Deleted branch diptych/${name}.`);
        }
      },
    );
}
