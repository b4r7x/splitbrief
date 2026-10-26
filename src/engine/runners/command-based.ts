import type { OutputFormat } from '../../core/schemas/enums.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { createCustomRunnerRedactor, resolveCustomRunnerEnvironment } from './redaction.js';
import {
  customRunnerAdmissionError,
  parseAdmittedCustomRunnerInvocation,
  revalidateCustomRunnerInvocation,
  type AdmittedCustomRunnerInvocation,
} from './custom-launchability.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from './cli-tools/process-invoke.js';

/**
 * Where the command comes from. An admitted custom command runs its revalidated absolute path
 * with only its declared environment; a config runner runs its command name on the given
 * (sandbox) environment.
 */
export type CommandRunnerSource =
  | Readonly<{
      kind: 'admitted';
      admission: AdmittedCustomRunnerInvocation;
      authorizationProjectDir: string;
      authorizationPathEnv?: string | undefined;
      authorizationPathExt?: string | undefined;
      sourceEnv: NodeJS.ProcessEnv;
      preserveEnvironmentKeys?: readonly string[] | undefined;
    }>
  | Readonly<{
      kind: 'config';
      runner: Readonly<{
        command: string;
        args?: readonly string[] | undefined;
        outputFormat?: OutputFormat | undefined;
        idleWarnMs?: number | undefined;
        idleKillMs?: number | undefined;
      }>;
      env: NodeJS.ProcessEnv;
      notFoundMessage: string;
    }>;

export type CommandRunnerOptions = Readonly<{
  source: CommandRunnerSource;
  prompt: string;
  cwd: string;
  callContext: RunnerCallContext;
  /** The seat's opt-in total (`timeout`); unset, the call has no deadline. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}>;

async function launchOf(source: CommandRunnerSource) {
  if (source.kind === 'config') {
    const { runner } = source;
    return {
      command: runner.command,
      args: runner.args ?? [],
      env: source.env,
      format: runner.outputFormat,
      idle: { warnMs: runner.idleWarnMs, killMs: runner.idleKillMs },
      notFoundMessage: source.notFoundMessage,
    };
  }

  const admission = parseAdmittedCustomRunnerInvocation(source.admission);
  if (admission === null) {
    throw customRunnerAdmissionError.invalid();
  }
  const { command } = admission.runner;
  const environment = resolveCustomRunnerEnvironment(source.sourceEnv, [
    ...command.env,
    ...(source.preserveEnvironmentKeys ?? []),
  ]);
  const executable = await revalidateCustomRunnerInvocation({
    invocation: admission,
    projectDir: source.authorizationProjectDir,
    pathEnv: source.authorizationPathEnv ?? '',
    pathExt: source.authorizationPathExt ?? '',
  });
  return {
    command: executable.path,
    args: command.argv,
    env: environment.env,
    format: command.outputFormat,
    idle: { warnMs: command.idleWarnMs, killMs: command.idleKillMs },
    credentialValues: environment.redactionValues,
    redact: createCustomRunnerRedactor(environment.redactionValues),
  };
}

/** Runs a shell or agent command through the no-shell process path, the prompt on its stdin. */
export async function invokeCommandRunner(opts: CommandRunnerOptions): Promise<RunnerCallResult> {
  const launch = await launchOf(opts.source);
  return spawnAndCollect({
    ...launch,
    cwd: opts.cwd,
    stdin: opts.prompt,
    onText: opts.onOutput,
    onStderr: opts.onStderr,
    onCallEvent: opts.onCallEvent,
    callContext: opts.callContext,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    outputBudgetBytes: CLI_RAW_OUTPUT_MAX_BYTES,
  });
}
