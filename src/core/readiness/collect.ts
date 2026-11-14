import { existsSync } from 'node:fs';
import { configPath } from '../config/load/document.js';
import type { EffectiveConfigWarning } from '../config/runtime/effective-config.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { buildReadinessReport } from './checks/build.js';
import { buildIsolationChecks } from './checks/isolation.js';
import { buildClaudeSandboxChecks, isOnSeatPath } from './checks/claude-sandbox.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from './status.js';
import type { Config } from '../schemas/config.js';
import { cliReadinessCheckId, type CliReadinessResult } from '../schemas/readiness.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool/catalog.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import type { WorkflowOpts } from '../types/config-options.js';
import type { SessionRef } from '../types/session-ref.js';
import type { BuildReadinessReportInput } from './checks/build.js';
import type { RunnerAvailabilityFact } from './checks/availability.js';
import type { CliRouteInputs } from './checks/cli-readiness.js';
import type { ReadinessCheck, ReadinessReport } from './types.js';
import type { SeatDisplayName } from '../crew/identity.js';
import type { SeatImageFact } from '../runners/capabilities.js';
import { readPackageScripts, readRepoPosture } from './repo-posture.js';
import { loadReadinessConfig } from './load-config.js';

export interface CollectedReadiness {
  report: ReadinessReport;
  config?: Config | undefined;
}

export interface CollectReadinessOptions {
  projectDir: string;
  opts?: WorkflowOpts | undefined;
  config?: Config | undefined;
  /** The warnings of the resolution that gave `config`. */
  configWarnings?: readonly EffectiveConfigWarning[] | undefined;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  /**
   * Optional for doctor-style diagnostics: what each CLI seat's route is read against, the model
   * the seat calls and the tool's model list. Without it, a route reads the seat's configured model
   * and no model list. Execution admission reads its own.
   */
  readCliRoutes?:
    | ((input: {
        projectDir: string;
        config: Config;
        cliReadiness: readonly CliReadinessResult[];
      }) => Promise<CliRouteInputs>)
    | undefined;
  /**
   * Optional live CLI probe for doctor-style diagnostics. Execution admission
   * performs its own fresh generic runner preparation.
   */
  detectCliReadiness?:
    | ((input: {
        projectDir: string;
        config: Config;
        opts: WorkflowOpts;
      }) => Promise<readonly CliReadinessResult[]>)
    | undefined;
  /**
   * Live reachability probe for the `api` runners a run will
   * actually call. Without it readiness makes no availability claim, and an
   * unreachable implementer only surfaces after the planning phase is paid for.
   */
  probeRunnerAvailability?:
    | ((input: { config: Config }) => Promise<readonly RunnerAvailabilityFact[]>)
    | undefined;
  /** How the run the report describes starts; a headless one approves its plan card unattended. */
  interaction?: 'interactive' | 'headless' | undefined;
  /** The seats the run will call. Omitted, the report covers every seat, as `doctor` does. */
  roles?: readonly ActiveRunnerRole[] | undefined;
  /**
   * Optional headless-equivalent runner admission probe for doctor-style
   * diagnostics. Execution admission performs its own fresh generic runner
   * preparation.
   */
  probeRunnerAdmission?:
    | ((input: {
        projectDir: string;
        config: Config;
        interaction: 'interactive' | 'headless';
      }) => Promise<readonly ReadinessCheck[]>)
    | undefined;
  resumeSession?: SessionRef | undefined;
  /** Names each seat's model by the catalog label the crew surfaces show. */
  seatDisplayName?: SeatDisplayName | undefined;
  /** The detected image fact of an API seat's model; the REVIEW line needs it for its render note. */
  seatImageFact: SeatImageFact;
  /** The default build seat's detected window; the context check reads it when no Prompt budget is set. */
  detectedContextLength?: number | undefined;
}

const CLI_READINESS_CHECK_IDS = new Set(CLI_TOOL_IDS.map((tool) => cliReadinessCheckId(tool)));

export function applyRunnerPreparationChecks(
  report: ReadinessReport,
  runnerChecks: readonly ReadinessCheck[],
): ReadinessReport {
  // A seat verdict that carries a readiness check as one of its warnings (a route with no
  // credential) supersedes that check, so one fact is reported and counted once.
  const restated = new Set(runnerChecks.flatMap((check) => check.metadata?.warnings ?? []));
  const sections = report.sections.map((section) =>
    section.id === 'runners'
      ? {
          ...section,
          checks: [
            ...section.checks.filter(
              (check) => !CLI_READINESS_CHECK_IDS.has(check.id) && !restated.has(check.id),
            ),
            ...runnerChecks,
          ],
        }
      : section,
  );
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  return {
    ...report,
    sections,
    counts,
    status,
    nextAction: selectNextAction(checks, status),
  };
}

export async function collectReadiness(
  options: CollectReadinessOptions,
): Promise<CollectedReadiness> {
  const configFile = configPath(options.projectDir);
  const configExists = existsSync(configFile);
  const loaded = loadReadinessConfig(options, configFile, configExists);
  const packageScripts = readPackageScripts(options.projectDir);
  const repo = await readRepoPosture(options.projectDir, options.resumeSession);
  let cliReadiness = options.cliReadiness;
  if (cliReadiness === undefined && loaded.config && options.detectCliReadiness) {
    try {
      cliReadiness = await options.detectCliReadiness({
        projectDir: options.projectDir,
        config: loaded.config,
        opts: options.opts ?? {},
      });
    } catch {
      // A missing or failed live probe is represented by an empty diagnostic
      // result so runner readiness emits its existing blocker.
      cliReadiness = [];
    }
  }
  const cliRoutes =
    loaded.config && options.readCliRoutes
      ? await options.readCliRoutes({
          projectDir: options.projectDir,
          config: loaded.config,
          cliReadiness: cliReadiness ?? [],
        })
      : undefined;
  let availability: readonly RunnerAvailabilityFact[] | undefined;
  if (loaded.config && options.probeRunnerAvailability) {
    try {
      availability = await options.probeRunnerAvailability({ config: loaded.config });
    } catch {
      // A probe that could not run makes no claim, so readiness falls back to
      // its "not probed" notice rather than reporting the runners as available.
      availability = undefined;
    }
  }
  const input: BuildReadinessReportInput = {
    projectDir: options.projectDir,
    configLoad: loaded.configLoad,
    packageScripts,
    repo,
    ...(loaded.config !== undefined && { config: loaded.config }),
    ...(cliReadiness !== undefined && { cliReadiness }),
    ...(cliRoutes !== undefined && { cliRoutes }),
    ...(availability !== undefined && { availability }),
    ...(options.interaction !== undefined && { interaction: options.interaction }),
    ...(options.seatDisplayName !== undefined && { seatDisplayName: options.seatDisplayName }),
    seatImageFact: options.seatImageFact,
    ...(options.detectedContextLength !== undefined && {
      detectedContextLength: options.detectedContextLength,
    }),
  };

  let report = buildReadinessReport(input);
  let isolationChecks: ReadinessCheck[];
  try {
    isolationChecks = buildIsolationChecks(options.projectDir, loaded.isolation);
  } catch (err) {
    isolationChecks = [
      {
        id: 'isolation.check-failed',
        severity: 'warning',
        summary: 'Worktree compatibility could not be checked.',
        details: [toErrorMessage(err, { preserveLineBreaks: true })],
      },
    ];
  }
  if (isolationChecks.length > 0) {
    mergeChecks(report, { id: 'repo', title: 'Repository' }, isolationChecks);
  }
  // Only the implementer starts Claude Code's sandbox, so a run that calls no
  // implementer (a spec run, a one-shot review) does not need bwrap or socat.
  if (loaded.config && (options.roles?.includes('implementer') ?? true)) {
    const sandboxChecks = buildClaudeSandboxChecks(loaded.config, {
      platform: process.platform,
      isOnPath: (program) => isOnSeatPath(program, options.projectDir),
    });
    if (sandboxChecks.length > 0) {
      mergeChecks(report, { id: 'runners', title: 'Runners' }, sandboxChecks);
    }
  }
  if (loaded.config && options.interaction && options.probeRunnerAdmission) {
    try {
      const admissionChecks = await options.probeRunnerAdmission({
        projectDir: options.projectDir,
        config: loaded.config,
        interaction: options.interaction,
      });
      if (admissionChecks.length > 0) {
        report = applyRunnerPreparationChecks(report, admissionChecks);
      }
    } catch {
      // A probe that could not run makes no admission claim.
    }
  }

  return {
    report,
    config: loaded.config,
  };
}

function mergeChecks(
  report: ReadinessReport,
  section: { id: string; title: string },
  checks: ReadinessCheck[],
): void {
  const existing = report.sections.find((candidate) => candidate.id === section.id);
  if (existing) {
    existing.checks.push(...checks);
  } else {
    report.sections.push({ id: section.id, title: section.title, checks });
  }
  const all = flattenReadinessChecks(report.sections);
  report.counts = countReadinessChecks(all);
  report.status = aggregateReadinessStatus(report.counts);
  report.nextAction = selectNextAction(all, report.status);
}
