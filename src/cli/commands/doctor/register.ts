import type { Command } from 'commander';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { collectReadiness } from '../../../core/readiness/collect.js';
import { formatReadinessReport } from '../../../core/readiness/format.js';
import { serializeReadinessReportJson } from '../../../core/readiness/json.js';
import type { RouteCatalogReads } from '../../../engine/detection/route-catalog.js';
import { writeHeadlessJsonRecord } from '../../../engine/events/public-json.js';
import { resolveSeatDisplayName } from '../../../engine/providers/model/display-names.js';
import { resolveSeatImageFact } from '../../../engine/providers/model/resolution.js';
import type { ArgVectorPreflightCheckInput } from '../../../engine/runners/arg-vector-preflight.js';
import type { collectRunnerAdmissionChecks } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import { probeRunnerAvailability } from '../../../engine/runners/probe-availability.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../../bootstrap/discovery.js';
import { canonicalizeProjectDir } from '../../setup.js';
import { withPreparationPreflights } from './preflights.js';
import { defaultSeatProbeCall } from './probe-call.js';
import { parseSeatProbeSeat, runSeatProbe } from './seat-probe.js';
import { SEAT_PROBE_SEATS, type SeatProbeCall } from './seat-probe.js';
import {
  detectConfiguredCliReadiness,
  type DetectCliReadiness,
  readConfiguredCliRoutes,
} from '../../configured-readiness.js';

interface DoctorOpts {
  project?: string | undefined;
  json?: boolean | undefined;
  probeSeat?: string | undefined;
}

export interface DoctorDeps {
  detectCliReadiness?: DetectCliReadiness | undefined;
  readCliRoutes?: typeof readConfiguredCliRoutes | undefined;
  runArgVectorHelp?: ArgVectorPreflightCheckInput['runHelp'] | undefined;
  probeRunnerAvailability?: typeof probeRunnerAvailability | undefined;
  collectRunnerAdmissionChecks?: typeof collectRunnerAdmissionChecks | undefined;
  probeSeatCall?: SeatProbeCall | undefined;
}

export function registerDoctorCommand(program: Command, deps: DoctorDeps = {}): void {
  program
    .command('doctor')
    .description('Check run readiness without creating a workflow session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Emit readiness as JSON', false)
    .option(
      '--probe-seat <seat>',
      `Make one paid call through one seat: ${SEAT_PROBE_SEATS.join(', ')}`,
    )
    .action(async (opts: DoctorOpts) => {
      const projectDir = await canonicalizeProjectDir(opts);
      if (opts.probeSeat !== undefined) {
        const seat = parseSeatProbeSeat(opts.probeSeat);
        const result = await runSeatProbe({
          projectDir,
          seat,
          call: deps.probeSeatCall ?? defaultSeatProbeCall,
        });
        console.log(`Seat probe ${CREW_SEAT_LABELS[seat]}: ${result.class}`);
        if (result.firstErrorLine !== null) console.log(`First error: ${result.firstErrorLine}`);
        return;
      }
      // A run started the way this doctor run was started is what the report
      // describes: piped or --json stdin gets no confirmation prompt, so the
      // consent verdict is the headless one.
      const interaction =
        opts.json === true || process.stdin.isTTY !== true ? 'headless' : 'interactive';
      await loadRememberedCatalog(projectDir);
      // The routes pass and the admission pass read each tool's model list once between them.
      const routeCatalogs: RouteCatalogReads = new Map();
      const readCliRoutes = deps.readCliRoutes ?? readConfiguredCliRoutes;
      const collected = await collectReadiness({
        projectDir,
        interaction,
        readCliRoutes: (input) => readCliRoutes({ ...input, routeCatalogs }),
        detectCliReadiness: deps.detectCliReadiness ?? detectConfiguredCliReadiness,
        probeRunnerAvailability: deps.probeRunnerAvailability ?? probeRunnerAvailability,
        seatDisplayName: (runner, role) => resolveSeatDisplayName(runner, role, modelCacheStore),
        seatImageFact: (runner, role) =>
          resolveSeatImageFact({ runner, role, cache: modelCacheStore }),
      });
      const report = await withPreparationPreflights({
        collected,
        projectDir,
        interaction,
        runHelp: deps.runArgVectorHelp,
        collectAdmissionChecks: deps.collectRunnerAdmissionChecks,
        routeCatalogs,
      });

      if (opts.json) {
        writeHeadlessJsonRecord({
          type: 'readiness_report',
          report: serializeReadinessReportJson(report),
        });
      } else {
        console.log(formatReadinessReport(report));
      }

      if (report.status === 'blocked') {
        process.exitCode = 1;
      }
    });
}
