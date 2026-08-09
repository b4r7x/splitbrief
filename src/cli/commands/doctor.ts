import type { Command } from 'commander';
import {
  applyRunnerPreparationChecks,
  collectReadiness,
  type CollectedReadiness,
} from '../../core/readiness/collect.js';
import {
  formatReadinessReport,
  readinessBlockerMessage,
  serializeReadinessReportJson,
} from '../../core/readiness/format.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import { CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { cliReadinessCheckId } from '../../core/schemas/readiness.js';
import {
  collectArgVectorPreflightChecks,
  type ArgVectorPreflightCheckInput,
} from '../../engine/runners/arg-vector-preflight.js';
import { collectCustomRunnerConsentChecks } from '../../engine/runners/consent-preflight.js';
import { collectRunnerAdmissionChecks } from '../../engine/runners/prepare-execution.js';
import { probeRunnerAvailability } from '../../engine/runners/probe-availability.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import { detectConfiguredCliReadiness } from './start/readiness.js';
import type { DetectCliReadiness } from './start/readiness.js';

interface DoctorOpts {
  project?: string | undefined;
  json?: boolean | undefined;
  probeValidation?: boolean | undefined;
}

export interface DoctorDeps {
  detectCliReadiness?: DetectCliReadiness | undefined;
  runArgVectorHelp?: ArgVectorPreflightCheckInput['runHelp'] | undefined;
  probeRunnerAvailability?: typeof probeRunnerAvailability | undefined;
  collectRunnerAdmissionChecks?: typeof collectRunnerAdmissionChecks | undefined;
}

const CLI_READINESS_CHECK_IDS: ReadonlySet<string> = new Set(
  CLI_TOOL_IDS.map((tool) => cliReadinessCheckId(tool)),
);

/**
 * The arg-vector preflight is what execution preparation runs before the first
 * planner call; running it here makes that verdict inspectable without starting
 * a run, at the price of one local `--help` per configured CLI runner against
 * the executable identity the trust ladder already admitted. The consent
 * preflight is the same idea for `shell`/`agent` runners: without it doctor
 * reported a trust-boundary warning and exited 0 on a config the run it
 * recommends refuses.
 *
 * `applyRunnerPreparationChecks` replaces the runners section's CLI readiness
 * checks, because a preparation's own verdicts supersede them. Doctor prepares
 * nothing — its CLI readiness checks are the live probe's verdict — so they are
 * re-supplied alongside the preflight's.
 */
async function withPreparationPreflights(
  collected: CollectedReadiness,
  projectDir: string,
  interaction: 'interactive' | 'headless',
  runHelp: ArgVectorPreflightCheckInput['runHelp'],
  collectAdmissionChecks: typeof collectRunnerAdmissionChecks = collectRunnerAdmissionChecks,
): Promise<ReadinessReport> {
  const config = collected.config;
  if (config === undefined) return collected.report;
  const argVectorChecks = await collectArgVectorPreflightChecks({
    config,
    projectDir,
    includeImplementers: true,
    ...(runHelp !== undefined && { runHelp }),
  });
  const consentChecks = await collectCustomRunnerConsentChecks({
    config,
    projectDir,
    interaction,
  });
  const admissionChecks =
    interaction === 'headless'
      ? await collectAdmissionChecks({
          projectDir,
          config,
          interaction,
        })
      : [];
  const cliReadinessChecks = collected.report.sections
    .filter((section) => section.id === 'runners')
    .flatMap((section) => section.checks)
    .filter((check) => CLI_READINESS_CHECK_IDS.has(check.id));
  return applyRunnerPreparationChecks(collected.report, [
    ...cliReadinessChecks,
    ...admissionChecks,
    ...argVectorChecks,
    ...consentChecks,
  ]);
}

export function registerDoctorCommand(program: Command, deps: DoctorDeps = {}): void {
  program
    .command('doctor')
    .description(
      'Check run readiness without creating a workflow session (validation commands run only with --probe-validation)',
    )
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Emit readiness as JSON', false)
    .option(
      '--probe-validation',
      'Run the configured validation commands to flag a pre-broken tree (can take minutes)',
      false,
    )
    .action(async (opts: DoctorOpts) => {
      const projectDir = await canonicalizeProjectDir(opts);
      const collected = await collectReadiness({
        projectDir,
        probeValidation: opts.probeValidation === true,
        detectCliReadiness: deps.detectCliReadiness ?? detectConfiguredCliReadiness,
        probeRunnerAvailability: deps.probeRunnerAvailability ?? probeRunnerAvailability,
      });
      // A run started the way this doctor run was started is what the report
      // describes: piped or --json stdin gets no confirmation prompt, so the
      // consent verdict is the headless one.
      const interaction =
        opts.json === true || process.stdin.isTTY !== true ? 'headless' : 'interactive';
      const report = await withPreparationPreflights(
        collected,
        projectDir,
        interaction,
        deps.runArgVectorHelp,
        deps.collectRunnerAdmissionChecks,
      );

      if (opts.json) {
        writeHeadlessJsonRecord({
          type: 'readiness_report',
          report: serializeReadinessReportJson(report),
        });
      } else {
        console.log(formatReadinessReport(report));
      }

      if (report.status === 'blocked') {
        throw cliError(readinessBlockerMessage(report), 1);
      }
    });
}
