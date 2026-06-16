import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  maybeMigrateWithSummaryRepair,
  migrateWithSummaryRepair,
  type MigrationResult,
} from '../../core/migration/executor.js';
import type { SessionSummaryRepairResult } from '../../core/migration/session-summary-repair.js';
import { assertNever } from '../../utils/type-guards.js';

function hasRepairActivity(repair: SessionSummaryRepairResult): boolean {
  return (
    repair.repaired > 0 ||
    repair.skippedInvalid > 0 ||
    repair.skippedUnreadable > 0 ||
    repair.warnings.length > 0
  );
}

function printMigrationResult(
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

function printRepairResult(repair: SessionSummaryRepairResult): void {
  for (const warning of repair.warnings) {
    console.warn(warning);
  }
  if (repair.skippedInvalid > 0) {
    console.warn(`Skipped ${repair.skippedInvalid} invalid session summary file(s).`);
  }
  if (repair.skippedUnreadable > 0) {
    console.warn(`Skipped ${repair.skippedUnreadable} unreadable session summary file(s).`);
  }
  if (repair.repaired > 0) {
    console.log(`Repaired ${repair.repaired} legacy session summary file(s).`);
  }
}

export async function maybeMigrateAndReport(
  projectDir: string,
  opts: { json?: boolean; rpc?: boolean },
): Promise<void> {
  const { migration, repair } = await maybeMigrateWithSummaryRepair(projectDir);
  if (!opts.json && !opts.rpc) {
    printMigrationResult(migration, {
      includeNotNeeded: migration.status === 'not-needed' && !hasRepairActivity(repair),
    });
    printRepairResult(repair);
  }
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate pre-v3 .diptych/current/ state to new session folder layout')
    .option('-p, --project <dir>', 'Project directory', '.')
    .action(async (opts: { project: string }) => {
      const projectDir = resolve(opts.project);
      const { migration, repair } = await migrateWithSummaryRepair(projectDir);
      printMigrationResult(migration, {
        includeNotNeeded: migration.status === 'not-needed' && !hasRepairActivity(repair),
      });
      printRepairResult(repair);
    });
}
