import type { Command } from 'commander';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import {
  applyRunnerPreparationChecks,
  collectReadiness,
  type CollectedReadiness,
} from '../../core/readiness/collect.js';
import {
  formatReadinessReport,
  serializeReadinessReportJson,
} from '../../core/readiness/format.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { sameRunnerCause } from '../../core/readiness/runner-causes.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { cliReadinessCheckId } from '../../core/schemas/readiness.js';
import {
  collectArgVectorPreflightChecks,
  type ArgVectorPreflightCheckInput,
} from '../../engine/runners/arg-vector-preflight.js';
import { collectCustomRunnerConsentChecks } from '../../engine/runners/consent-preflight.js';
import { collectRunnerAdmissionChecks } from '../../engine/runners/prepare-execution/prepare-execution.js';
import { probeRunnerAvailability } from '../../engine/runners/probe-availability.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import { detectConfiguredCliReadiness, readConfiguredCliRoutes } from './start/readiness.js';
import type { RouteCatalogReads } from '../../engine/detection/route-catalog.js';
import type { DetectCliReadiness } from './start/readiness.js';
import { appendFile, chmod, mkdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSplitbriefPath } from '../../core/paths.js';
import { loadConfig } from '../../core/config/load/io.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import {
  classifySeatFailure,
  type SeatFailureClassification,
} from '../../engine/runners/seat-failure.js';
import { createProject, processRunnerOf } from '../../engine/runners/cli-tools/contract-harness.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
  CliProtocolEvent,
} from '../../engine/runners/cli-tools/contract.js';
import { preparePrompt } from '../../engine/runners/cli-tools/prompt-transport.js';
import {
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
} from '../../engine/runners/cli-tools/registry.js';
import { toCliEnvironment } from '../../engine/runners/invoke-cli-adapter.js';
import { createCustomRunnerRedactor } from '../../engine/runners/redaction.js';
import { clearBridgedCliState } from '../../engine/runners/sandbox-state-bridge.js';
import { sandboxCredentialValues } from '../../engine/runners/sandbox-credential-values.js';
import { createRunnerSandboxEnv } from '../../engine/runners/sandbox-env.js';
import { resolveCliExecutableAliases } from '../../engine/runners/resolve-cli-executable.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../bootstrap/discovery.js';

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

export const SEAT_PROBE_SEATS = ['plan', 'build', 'review'] as const;
export type SeatProbeSeat = (typeof SEAT_PROBE_SEATS)[number];

export type SeatProbeCapture = Readonly<{
  seat: SeatProbeSeat;
  tool: string;
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  signal: string | null;
  timedOut: boolean;
  outputExceeded: boolean;
}>;

export type SeatProbeCall = (
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat }>,
) => Promise<SeatProbeCapture>;

export type SeatProbeResult = Readonly<{
  seat: SeatProbeSeat;
  tool: string;
  class: SeatFailureClassification['class'] | 'passed';
  firstErrorLine: string | null;
  recordPath: string;
}>;

type CliTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

const SEAT_PROBE_PROMPT = 'Reply with the word ok.';
const SEAT_PROBE_TIMEOUT_MS = 60_000;
const SEAT_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const SEAT_PROBE_RECORDS_DIR = 'probes';

function parseSeatProbeSeat(value: string): SeatProbeSeat {
  const seat = SEAT_PROBE_SEATS.find((candidate) => candidate === value);
  if (seat !== undefined) return seat;
  throw cliError(`--probe-seat must be one of ${SEAT_PROBE_SEATS.join(', ')}.`, 1);
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function seatProbeDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function appendSeatProbeRecord(
  recordPath: string,
  record: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  await appendFile(recordPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(recordPath, 0o600);
}

export async function runSeatProbe(
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat; call: SeatProbeCall }>,
): Promise<SeatProbeResult> {
  const capture = await input.call({ projectDir: input.projectDir, seat: input.seat });
  const terminal = seatProbeTerminal(capture);
  const passed = terminal?.status === 'completed' && capture.exitStatus === 0;
  // A terminal result speaks for the call: its stream frames list tool names such as
  // `browser_get_network_request` that read as a network fault.
  const error = terminal?.error ?? null;
  const diagnostics = (
    terminal === null ? [capture.stderr, capture.stdout] : [error?.message ?? '', capture.stderr]
  )
    .filter((part) => part.trim().length > 0)
    .join('\n');
  const verdict = passed
    ? 'passed'
    : classifySeatFailure({
        message: diagnostics,
        ...(error !== null && { code: error.code }),
        ...(error?.status !== undefined && { status: error.status }),
        ...(error?.providerType !== undefined && { providerType: error.providerType }),
        ...(capture.exitStatus !== null && capture.exitStatus !== 0
          ? { outcome: 'non-zero-exit' as const }
          : {}),
        source: error === null ? 'thrown' : 'result-error',
      }).class;
  const firstErrorLine = passed ? null : firstNonEmptyLine(diagnostics);
  const recordPath = getSplitbriefPath(
    input.projectDir,
    SEAT_PROBE_RECORDS_DIR,
    `${capture.tool}-${seatProbeDate()}.jsonl`,
  );
  await appendSeatProbeRecord(recordPath, {
    ts: new Date().toISOString(),
    seat: input.seat,
    tool: capture.tool,
    class: verdict,
    exitStatus: capture.exitStatus,
    timedOut: capture.timedOut,
    outputExceeded: capture.outputExceeded,
    stdout: capture.stdout,
    stderr: capture.stderr,
  });
  return {
    seat: input.seat,
    tool: capture.tool,
    class: verdict,
    firstErrorLine,
    recordPath,
  };
}

function seatProbeAdapter(
  tool: string,
  seat: SeatProbeSeat,
): CliPlannerAdapter | CliImplementerAdapter {
  return seat === 'build' ? lookupCliImplementerAdapter(tool) : lookupCliPlannerAdapter(tool);
}

/** The call's terminal result as the seat adapter reads it in a run; null when the stream has none. */
function seatProbeTerminal(capture: SeatProbeCapture): CliTerminalEvent | null {
  const adapter = seatProbeAdapter(capture.tool, capture.seat);
  const parse = adapter.createParser?.() ?? adapter.parse;
  try {
    return adapter.terminal({
      outputContract: adapter.outputContract,
      events: capture.stdout.split('\n').flatMap((line) => [...parse(line)]),
      stderr: capture.stderr,
      exitCode: capture.exitStatus,
      signal: capture.signal,
    });
  } catch {
    return null;
  }
}

function seatProbeRunner(config: Config, seat: SeatProbeSeat): RunnerConfig {
  switch (seat) {
    case 'plan':
      return config.planner;
    case 'build':
      return resolveImplementerProfiles(config).defaultProfile.config;
    case 'review':
      return resolveReviewerRunner(config).runner;
  }
}

async function defaultSeatProbeCall(
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat }>,
): Promise<SeatProbeCapture> {
  const { config } = loadConfig(input.projectDir);
  const runner = seatProbeRunner(config, input.seat);
  if (runner.kind !== 'cli') {
    throw cliError(
      `--probe-seat needs a CLI runner for ${CREW_SEAT_LABELS[input.seat]}; it is "${runner.kind}".`,
      1,
    );
  }
  const role: RunnerRole = input.seat === 'build' ? 'implementer' : 'planner';
  const adapter = seatProbeAdapter(runner.tool, input.seat);
  const workspace = await createProject(undefined);
  const workspaceDir = await realpath(workspace.path);
  try {
    const env = await createRunnerSandboxEnv(workspaceDir, runner, role);
    const executable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[runner.tool].executableAliases,
        projectDir: workspaceDir,
      })
    ).executable;
    const args = seatProbeArgs(adapter, runner, workspaceDir);
    const invocation: CliInvocation = {
      executable,
      args,
      baseArgs: args,
      promptTransport: adapter.promptTransport,
      environment: toCliEnvironment(env),
      cwd: workspaceDir,
      timeoutMs: SEAT_PROBE_TIMEOUT_MS,
      signal: undefined,
    };
    const prepared = await preparePrompt(adapter, invocation, args, SEAT_PROBE_PROMPT);
    const result = await processRunnerOf({})({
      command: executable.path,
      args: prepared.args,
      cwd: workspaceDir,
      env,
      stdin: prepared.stdin,
      timeoutMs: SEAT_PROBE_TIMEOUT_MS,
      maxOutputBytes: SEAT_PROBE_MAX_OUTPUT_BYTES,
    });
    const redact = createCustomRunnerRedactor(sandboxCredentialValues(env));
    return {
      seat: input.seat,
      tool: runner.tool,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      exitStatus: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputExceeded: result.outputExceeded,
    };
  } finally {
    await clearBridgedCliState(workspace.path);
    await workspace.cleanup();
  }
}

/** The seat's own model, effort, variant and args, so the probe asks the account the seat runs on. */
function seatProbeArgs(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
  runner: Extract<RunnerConfig, { kind: 'cli' }>,
  projectDir: string,
): readonly string[] {
  const seatArgs = {
    model: runner.model,
    projectDir,
    configuredArgs: runner.args ?? [],
    effort: runner.effort,
    variant: runner.variant,
  };
  const args =
    adapter.role === 'planner'
      ? adapter.buildArgs({ ...seatArgs, sessionId: null, oneShot: true })
      : adapter.buildArgs(seatArgs);
  return [...args];
}

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
async function withPreparationPreflights(options: {
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
