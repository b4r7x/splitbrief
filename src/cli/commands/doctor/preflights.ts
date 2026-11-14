import {
  type CollectedReadiness,
  applyRunnerPreparationChecks,
} from '../../../core/readiness/collect.js';
import { sameRunnerCause } from '../../../core/readiness/runner-causes.js';
import type { ReadinessCheck, ReadinessReport } from '../../../core/readiness/types.js';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool/catalog.js';
import { cliReadinessCheckId } from '../../../core/schemas/readiness.js';
import type { RouteCatalogReads } from '../../../engine/detection/route-catalog.js';
import {
  type ArgVectorPreflightCheckInput,
  collectArgVectorPreflightChecks,
} from '../../../engine/runners/arg-vector-preflight.js';
import { collectCustomRunnerConsentChecks } from '../../../engine/runners/consent-preflight.js';
import { collectRunnerAdmissionChecks } from '../../../engine/runners/prepare-execution/prepare-execution.js';

const CLI_READINESS_CHECK_IDS: ReadonlySet<string> = new Set(
  CLI_TOOL_IDS.map((tool) => cliReadinessCheckId(tool)),
);

/** The release each compatible CLI reported, as the start gate would admit it. */
function admittedVersions(checks: readonly ReadinessCheck[]): Record<string, string> {
  return Object.fromEntries(
    checks.flatMap(({ metadata }) =>
      typeof metadata?.['tool'] === 'string' &&
      typeof metadata['installedVersion'] === 'string' &&
      metadata['compatibility'] === 'compatible'
        ? [[metadata['tool'], metadata['installedVersion']]]
        : [],
    ),
  );
}

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
export async function withPreparationPreflights(options: {
  readonly collected: CollectedReadiness;
  readonly projectDir: string;
  readonly interaction: 'interactive' | 'headless';
  readonly runHelp?: ArgVectorPreflightCheckInput['runHelp'] | undefined;
  readonly collectAdmissionChecks?: typeof collectRunnerAdmissionChecks | undefined;
  readonly routeCatalogs: RouteCatalogReads;
}): Promise<ReadinessReport> {
  const {
    collected,
    projectDir,
    interaction,
    runHelp,
    collectAdmissionChecks = collectRunnerAdmissionChecks,
    routeCatalogs,
  } = options;
  const config = collected.config;
  if (config === undefined) return collected.report;
  const runnerChecks = collected.report.sections
    .filter((section) => section.id === 'runners')
    .flatMap((section) => section.checks);
  const cliReadinessChecks = runnerChecks.filter((check) => CLI_READINESS_CHECK_IDS.has(check.id));
  const argVectorChecks = await collectArgVectorPreflightChecks({
    config,
    projectDir,
    roles: ['planner', 'implementer', 'reviewer'],
    installedVersions: admittedVersions(cliReadinessChecks),
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
          routeCatalogs,
        })
      : [];
  return applyRunnerPreparationChecks(collected.report, [
    ...cliReadinessChecks.filter(
      (check) =>
        !admissionChecks.some(
          (admission) =>
            check.runnerCause !== undefined &&
            admission.runnerCause !== undefined &&
            sameRunnerCause(check.runnerCause, admission.runnerCause),
        ),
    ),
    // The consent replay reports every shell and agent seat, so admission adds the others.
    ...admissionChecks.filter(
      (check) => check.metadata?.kind !== 'shell' && check.metadata?.kind !== 'agent',
    ),
    ...argVectorChecks,
    ...consentChecks,
  ]);
}
