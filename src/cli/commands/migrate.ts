import { resolve } from 'node:path';
import { Command } from 'commander';
import { migrateCommand } from '../../core/migration/executor.js';

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate pre-v3 .diptych/current/ state to new session folder layout')
    .option('-p, --project <dir>', 'Project directory', '.')
    .action(async (opts: { project: string }) => {
      const projectDir = resolve(opts.project);
      await migrateCommand(projectDir);
    });
}
