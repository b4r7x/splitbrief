import type { Command } from 'commander';
import { collectReadiness } from '../../core/readiness/collect.js';
import { formatReadinessReport, readinessBlockerMessage } from '../../core/readiness/format.js';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import { detectConfiguredCliReadiness } from './start/readiness.js';
import type { DetectCliReadiness } from './start/types.js';

interface DoctorOpts {
  project?: string | undefined;
  json?: boolean | undefined;
}

export interface DoctorDeps {
  detectCliReadiness?: DetectCliReadiness | undefined;
}

export function registerDoctorCommand(program: Command, deps: DoctorDeps = {}): void {
  program
    .command('doctor')
    .description('Check run readiness without creating a workflow session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Emit readiness as JSON', false)
    .action(async (opts: DoctorOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      const { report } = await collectReadiness({
        projectDir,
        detectCliReadiness: deps.detectCliReadiness ?? detectConfiguredCliReadiness,
      });

      if (opts.json) {
        writeHeadlessJsonRecord({ type: 'readiness_report', report });
      } else {
        console.log(formatReadinessReport(report));
      }

      if (report.status === 'blocked') {
        throw cliError(readinessBlockerMessage(report), 1);
      }
    });
}
