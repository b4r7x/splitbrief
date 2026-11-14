import { realpath } from 'node:fs/promises';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { RunnerRole } from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  createProject,
  processRunnerOf,
} from '../../../engine/runners/cli-tools/contract-harness/harness.js';
import type {
  CliInvocation,
  CliPlannerAdapter,
  CliImplementerAdapter,
} from '../../../engine/runners/cli-tools/contract.js';
import { preparePrompt } from '../../../engine/runners/cli-tools/prompt-transport.js';
import { toCliEnvironment } from '../../../engine/runners/invoke-cli-adapter.js';
import { createCustomRunnerRedactor } from '../../../engine/runners/custom/redaction.js';
import { resolveCliExecutableAliases } from '../../../engine/runners/cli-executable/resolve.js';
import { sandboxCredentialValues } from '../../../engine/runners/sandbox/credential-values.js';
import { createRunnerSandboxEnv } from '../../../engine/runners/sandbox/env.js';
import { clearBridgedCliState } from '../../../engine/runners/sandbox/state/bridge.js';
import { cliError } from '../../errors.js';
import { type SeatProbeSeat, type SeatProbeCapture, seatProbeAdapter } from './seat-probe.js';

const SEAT_PROBE_PROMPT = 'Reply with the word ok.';
const SEAT_PROBE_TIMEOUT_MS = 60_000;
const SEAT_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

function seatProbeRunner(config: Config, seat: SeatProbeSeat): RunnerConfig {
  switch (seat) {
    case 'plan':
      return config.planner;
    case 'build':
      return resolveImplementerProfiles(config).defaultProfile.config;
    case 'review': {
      const reviewer = resolveReviewerRunner(config);
      if (reviewer.source === 'none') throw cliError('REVIEW is set to None; no seat to probe.', 1);
      return reviewer.runner;
    }
  }
}

export async function defaultSeatProbeCall(
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
      ? adapter.buildArgs({ ...seatArgs, sessionId: null })
      : adapter.buildArgs(seatArgs);
  return [...args];
}
