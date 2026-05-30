import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  maybeMigrate,
  migrateCommand,
  type MigrationResult,
} from '../../core/migration/executor.js';
import { assertNever } from '../../utils/type-guards.js';

export function printMigrationResult(
  result: MigrationResult,
  opts: { includeNotNeeded?: boolean } = {},
): void {
  for (const warning of 'warnings' in result ? result.warnings : []) {
    console.warn(warning);
  }

  switch (result.status) {
    case 'not-needed':
      if (opts.includeNotNeeded) console.log('Nothing to migrate.');
      return;
    case 'skipped':
      return;
    case 'migrated':
      console.log(`Migrated ${result.sessionId}. Run 'diptych resume' to continue.`);
      return;
    default:
      assertNever(result);
  }
}

export async function maybeMigrateAndReport(
  projectDir: string,
  opts: { json?: boolean; rpc?: boolean },
): Promise<void> {
  const migration = await maybeMigrate(projectDir);
  if (!opts.json && !opts.rpc) printMigrationResult(migration);
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate pre-v3 .diptych/current/ state to new session folder layout')
    .option('-p, --project <dir>', 'Project directory', '.')
    .action(async (opts: { project: string }) => {
      const projectDir = resolve(opts.project);
      printMigrationResult(await migrateCommand(projectDir), { includeNotNeeded: true });
    });
}
