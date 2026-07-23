import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { cliError, withCliErrors } from '../errors.js';
import { listWorktrees } from '../../engine/worktree/status.js';
import { removeWorktree } from '../../engine/worktree/remove.js';
import { worktreePath } from '../../core/paths.js';
import { createGitClient } from '../../lib/git/client.js';
import { renderTable } from '../render-table.js';
import type { WorktreeInfo } from '../../engine/worktree/status.js';

export interface WorktreeDeps {
  listWorktrees: typeof listWorktrees;
  removeWorktree: typeof removeWorktree;
}

const defaultDeps: WorktreeDeps = { listWorktrees, removeWorktree };

function renderList(worktrees: WorktreeInfo[]): void {
  const lines = renderTable<WorktreeInfo>({
    columns: [
      {
        header: 'NAME',
        min: 12,
        value: (w) => w.name,
        shrink: true,
        shrinkPriority: 2,
        truncate: true,
      },
      {
        header: 'PATH',
        min: 18,
        value: (w) => w.path,
        shrink: true,
        shrinkPriority: 0,
        truncate: true,
      },
      {
        header: 'BRANCH',
        min: 18,
        value: (w) => w.branch,
        shrink: true,
        shrinkPriority: 1,
        truncate: true,
      },
      { header: 'STATUS', min: 10, value: (w) => w.status },
      { header: 'SESSION', min: 12, value: (w) => w.sessionId ?? 'unknown' },
      { header: 'PHASE', min: 10, value: (w) => w.phase ?? 'unknown' },
      { header: 'UPDATED', min: 12, value: (w) => w.lastUpdated ?? 'unknown' },
    ],
    rows: worktrees,
  });
  for (const line of lines) console.log(line);
}

export function registerWorktreeCommand(program: Command, deps: WorktreeDeps = defaultDeps): void {
  const worktree = program.command('worktree').description('Manage diptych-managed git worktrees');

  worktree
    .command('list')
    .description('List all diptych-managed worktrees')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const worktrees = await deps.listWorktrees(projectDir);

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
      const worktrees = await deps.listWorktrees(projectDir);
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
    .command('path <name>')
    .description('Print the resolved filesystem path of a worktree')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (name: string, opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const worktrees = await deps.listWorktrees(projectDir);
      const found = worktrees.some((w) => w.name === name);

      if (!found) {
        throw cliError(`Worktree "${name}" not found.`, 1);
      }

      console.log(worktreePath(projectDir, name));
    });

  worktree
    .command('remove <name>')
    .description('Remove a diptych-managed worktree')
    .option('--force', 'Bypass live-session and uncommitted-changes guards')
    .option('--delete-branch', 'Also delete the diptych/<name> branch')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(
      async (name: string, opts: { force?: boolean; deleteBranch?: boolean; project?: string }) => {
        const projectDir = resolveProjectDir(opts.project);
        const git = createGitClient(projectDir);

        await withCliErrors(() =>
          deps.removeWorktree({
            projectDir,
            slug: name,
            git,
            force: opts.force ?? false,
            deleteBranch: opts.deleteBranch ?? false,
          }),
        );

        console.log(`Removed worktree ".trees/${name}".`);
        if (opts.deleteBranch) {
          console.log(`Deleted branch diptych/${name}.`);
        }
      },
    );
}
