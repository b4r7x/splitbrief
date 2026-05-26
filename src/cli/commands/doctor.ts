import type { Command } from 'commander';
import { collectReadiness } from '../../core/readiness/collect.js';
import { formatReadinessReport, readinessBlockerMessage } from '../../core/readiness/format.js';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';

interface DoctorOpts {
  project?: string | undefined;
  json?: boolean | undefined;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check run readiness without creating a workflow session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Emit readiness as JSON', false)
    .action(async (opts: DoctorOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      const { report } = await collectReadiness({ projectDir });

      if (opts.json) {
        process.stdout.write(JSON.stringify({ type: 'readiness_report', report }) + '\n');
      } else {
        console.log(formatReadinessReport(report));
      }

      if (report.status === 'blocked') {
        throw cliError(readinessBlockerMessage(report), 1);
      }
    });
}
