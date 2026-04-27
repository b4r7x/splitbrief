import { Command } from 'commander';
import ansis from 'ansis';
import { resolveProjectDir } from '../setup.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { createSnapshot, listSnapshots } from '../../engine/snapshots/store.js';
import { resolveSnapshot, restoreSnapshot } from '../../engine/snapshots/restore.js';
import { computeSnapshotDiff, formatSnapshotDiff } from '../../engine/snapshots/diff.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command('snapshot')
    .description('Manage working-tree snapshots for a diptych session');

  snapshot
    .command('create')
    .description('Create a snapshot of the current working tree')
    .option('--name <name>', 'Human label for this snapshot')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { name?: string; session?: string; project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const sessionId = opts.session ?? readActive(projectDir);
      if (!sessionId) {
        throw cliError('No active session. Pass --session <id>.', 1);
      }

      try {
        const result = await createSnapshot({
          projectDir,
          sessionId,
          phase: 'manual',
          ...(opts.name !== undefined && { name: opts.name }),
        });

        // The first call into `createSnapshot` always materializes the
        // baseline as id "baseline" and reports `isFirstSnapshot: true`.
        // The user has no way to refer to a baseline (it is filtered out
        // of `snapshot list`), so on the very first invocation we follow
        // up with a second snapshot so the user-requested label becomes a
        // listable, restorable entry.
        if (result.isFirstSnapshot) {
          const followup = await createSnapshot({
            projectDir,
            sessionId,
            phase: 'manual',
            ...(opts.name !== undefined && { name: opts.name }),
          });
          console.log('Initialized snapshot baseline.');
          console.log(`Snapshot created: ${followup.manifest.id}`);
          if (opts.name) {
            console.log(`  Name: ${opts.name}`);
          }
          console.log(`  Files: ${followup.manifest.trackedFileCount}`);
          console.log(`  Location: ${followup.snapshotDir}`);
          return;
        }

        console.log(`Snapshot created: ${result.manifest.id}`);
        if (opts.name) {
          console.log(`  Name: ${opts.name}`);
        }
        console.log(`  Files: ${result.manifest.trackedFileCount}`);
        console.log(`  Location: ${result.snapshotDir}`);
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }
    });

  snapshot
    .command('list')
    .description('List snapshots for a session')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { session?: string; project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const sessionId = opts.session ?? readActive(projectDir);
      if (!sessionId) {
        throw cliError('No active session. Pass --session <id>.', 1);
      }

      try {
        const { manifests } = await listSnapshots(projectDir, sessionId);

        if (manifests.length === 0) {
          console.log(`No snapshots found for session ${sessionId}.`);
          return;
        }

        for (const m of manifests) {
          const namePart = m.name ? `  ${ansis.dim(m.name)}` : '';
          console.log(
            `${m.id}  ${m.createdAt}  files=${m.trackedFileCount}  phase=${m.phase}${namePart}`,
          );
        }
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }
    });

  snapshot
    .command('restore <id-or-name>')
    .description('Restore the working tree to a snapshot state')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--force', 'Overwrite files even if modified after snapshot')
    .action(async (idOrName: string, opts: { session?: string; project?: string; force?: boolean }) => {
      const projectDir = resolveProjectDir(opts.project);
      const sessionId = opts.session ?? readActive(projectDir);
      if (!sessionId) {
        throw cliError('No active session. Pass --session <id>.', 1);
      }

      let result: Awaited<ReturnType<typeof restoreSnapshot>>;
      try {
        result = await restoreSnapshot({
          projectDir,
          sessionId,
          idOrName,
          force: opts.force ?? false,
        });
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }

      console.log(`Restored ${result.restoredPaths.length} file(s) from snapshot ${result.snapshotId}.`);

      if (result.conflictedPaths.length > 0) {
        console.log('Conflicts (not restored — modified since snapshot):');
        for (const p of result.conflictedPaths) {
          console.log(`  ${p}`);
        }
        console.log('Run with --force to overwrite.');
      }

      if (result.forcedPaths.length > 0) {
        console.log(`Forced (${result.forcedPaths.length} file(s) overwritten):`);
        for (const p of result.forcedPaths) {
          console.log(`  ${p}`);
        }
      }

      if (result.missingSnapshotFiles.length > 0) {
        console.log(
          `Warning: ${result.missingSnapshotFiles.length} file(s) missing from snapshot storage (skipped).`,
        );
      }

      if (result.conflictedPaths.length > 0) {
        process.exit(1);
      }
    });

  snapshot
    .command('diff <id-or-name>')
    .description('Show diff between current working tree and a snapshot')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-color', 'Disable color output')
    .action(async (idOrName: string, opts: { session?: string; project?: string; color?: boolean }) => {
      const projectDir = resolveProjectDir(opts.project);
      const sessionId = opts.session ?? readActive(projectDir);
      if (!sessionId) {
        throw cliError('No active session. Pass --session <id>.', 1);
      }

      let manifest: Awaited<ReturnType<typeof resolveSnapshot>>;
      try {
        manifest = await resolveSnapshot(projectDir, sessionId, idOrName);
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }

      let result: Awaited<ReturnType<typeof computeSnapshotDiff>>;
      try {
        result = await computeSnapshotDiff({ projectDir, sessionId, manifest });
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }

      const formatted = formatSnapshotDiff(result, { color: opts.color !== false });
      console.log(formatted);

      if (result.changedCount > 0) {
        process.exit(1);
      }
    });
}
