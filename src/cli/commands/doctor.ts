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
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
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
import { detectConfiguredCliReadiness } from './start/readiness.js';
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
import { CLI_PROMPT_SENTINEL } from '../../engine/runners/cli-tools/candidate-contract.js';
import { createProject, processRunnerOf } from '../../engine/runners/cli-tools/contract-harness.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
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

interface DoctorOpts {
  project?: string | undefined;
  json?: boolean | undefined;
  probeValidation?: boolean | undefined;
  probeSeat?: string | undefined;
}

export interface DoctorDeps {
  detectCliReadiness?: DetectCliReadiness | undefined;
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
  timedOut: boolean;
  outputExceeded: boolean;
}>;

export type SeatProbeCall = (
  input: Readonly<{ projectDir: string; seat: SeatProbeSeat }>,
) => Promise<SeatProbeCapture>;

export type SeatProbeResult = Readonly<{
  seat: SeatProbeSeat;
  tool: string;
  class: SeatFailureClassification['class'];
  firstErrorLine: string | null;
  recordPath: string;
}>;

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
  const classification = classifySeatFailure({
    message: [capture.stderr, capture.stdout].filter((part) => part.trim().length > 0).join('\n'),
    ...(capture.exitStatus !== null && capture.exitStatus !== 0
      ? { outcome: 'non-zero-exit' as const }
      : {}),
    source: 'thrown',
  });
  const firstErrorLine = firstNonEmptyLine(capture.stderr) ?? firstNonEmptyLine(capture.stdout);
  const recordPath = getSplitbriefPath(
    input.projectDir,
    SEAT_PROBE_RECORDS_DIR,
    `${capture.tool}-${seatProbeDate()}.jsonl`,
  );
  await appendSeatProbeRecord(recordPath, {
    ts: new Date().toISOString(),
    seat: input.seat,
    tool: capture.tool,
    class: classification.class,
    exitStatus: capture.exitStatus,
    timedOut: capture.timedOut,
    outputExceeded: capture.outputExceeded,
    stdout: capture.stdout,
    stderr: capture.stderr,
  });
  return {
    seat: input.seat,
    tool: capture.tool,
    class: classification.class,
    firstErrorLine,
    recordPath,
  };
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
      `--probe-seat needs a CLI runner for the ${input.seat} seat; it is "${runner.kind}".`,
      1,
    );
  }
  const role: RunnerRole = input.seat === 'build' ? 'implementer' : 'planner';
  const adapter =
    role === 'implementer'
      ? lookupCliImplementerAdapter(runner.tool)
      : lookupCliPlannerAdapter(runner.tool);
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
    try {
      const result = await processRunnerOf({})({
        command: executable.path,
        args: prepared.args,
        cwd: workspaceDir,
        env,
        ...(prepared.stdin === undefined ? {} : { stdin: prepared.stdin }),
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
        timedOut: result.timedOut,
        outputExceeded: result.outputExceeded,
      };
    } finally {
      await prepared.cleanup();
    }
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
    prompt: CLI_PROMPT_SENTINEL,
    model: runner.model,
    projectDir,
    configuredArgs: runner.args ?? [],
    effort: runner.effort,
    variant: runner.variant,
  };
  const args =
    adapter.role === 'planner'
      ? adapter.buildArgs({ ...seatArgs, mode: 'plan', sessionId: null, oneShot: true })
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
}): Promise<ReadinessReport> {
  const {
    collected,
    projectDir,
    interaction,
    runHelp,
    collectAdmissionChecks = collectRunnerAdmissionChecks,
  } = options;
  const config = collected.config;
  if (config === undefined) return collected.report;
  const cliReadinessChecks = collected.report.sections
    .filter((section) => section.id === 'runners')
    .flatMap((section) => section.checks)
    .filter((check) => CLI_READINESS_CHECK_IDS.has(check.id));
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
        })
      : [];
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
    .option(
      '--probe-seat <seat>',
      'Make one paid call through the plan, build or review seat adapter',
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
        console.log(`Seat probe ${seat}: ${result.class}`);
        if (result.firstErrorLine !== null) console.log(`First error: ${result.firstErrorLine}`);
        return;
      }
      // A run started the way this doctor run was started is what the report
      // describes: piped or --json stdin gets no confirmation prompt, so the
      // consent verdict is the headless one.
      const interaction =
        opts.json === true || process.stdin.isTTY !== true ? 'headless' : 'interactive';
      const collected = await collectReadiness({
        projectDir,
        interaction,
        probeValidation: opts.probeValidation === true,
        detectCliReadiness: deps.detectCliReadiness ?? detectConfiguredCliReadiness,
        probeRunnerAvailability: deps.probeRunnerAvailability ?? probeRunnerAvailability,
      });
      const report = await withPreparationPreflights({
        collected,
        projectDir,
        interaction,
        runHelp: deps.runArgVectorHelp,
        collectAdmissionChecks: deps.collectRunnerAdmissionChecks,
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
        throw cliError(readinessBlockerMessage(report), 1);
      }
    });
}
