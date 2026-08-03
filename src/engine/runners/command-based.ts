import type { OutputFormat } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { toTokenDelta } from '../calls/projection.js';
import {
  boundedRunnerCallMessage,
  createRunnerCallCredentialRedactor,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { credentialValuesFromEnvironment, spawnAndCollect } from '../streaming/spawn-collect.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { createParsedLineRecorder } from '../streaming/parsed-line-recorder.js';
import { createRunnerCallStderrBuffer } from '../streaming/stderr-lines.js';
import { createBoundedOutput } from '../../lib/process/bounded-output.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
} from '../../lib/process/spawn/lifecycle.js';
import { spawnWithShellFallback } from '../../lib/process/spawn/progress.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { processError } from '../../lib/process/errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { redactSecrets } from '../../utils/redact.js';
import { error } from '../../utils/error.js';
import { finishRunnerCallOutputLimit, runnerCallLineOutputLimit } from '../calls/output-limit.js';
import { commandName, isShellEvaluatedPromptArg } from '../../core/trust/path-classification.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { createCustomRunnerRedactor, resolveCustomRunnerEnvironment } from './redaction.js';
import {
  customRunnerAdmissionError,
  parseAdmittedCustomRunnerInvocation,
  revalidateCustomRunnerInvocation,
  type AdmittedCustomRunnerInvocation,
} from './trust.js';

const PROMPT_PLACEHOLDER = '{prompt}';
const CUSTOM_RUNNER_PROMPT_MAX_BYTES = 1024 * 1024;
const CUSTOM_RUNNER_PROCESS_OUTPUT_MAX_BYTES = 1_310_720;
const CUSTOM_RUNNER_HARD_DEADLINE_MS = 3_600_000;

export const commandBasedInvocationError = {
  promptPlaceholderInCommand: (command: string) =>
    error(
      'runner-command-prompt-placeholder',
      'Runner command must not contain {prompt}; pass the prompt through stdin or args instead.',
      { command },
    ),
  shellEvaluatedPrompt: (opts: { command: string; args: readonly string[] }) =>
    error(
      'runner-shell-evaluated-prompt',
      `Runner args must not pass {prompt} through ${commandName(opts.command)} -c; use stdin or a non-shell argv placeholder instead.`,
      { command: opts.command, args: opts.args },
    ),
  customPromptTooLarge: (maxBytes: number) =>
    error('custom-runner-prompt-too-large', `Custom runner prompt exceeds ${maxBytes} bytes.`, {
      maxBytes,
    }),
} as const;

export interface CommandBasedOptions {
  command: string;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  supportPromptPlaceholder?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeout?: number | undefined;
  notFoundMessage?: string | undefined;
  allowShellEvaluatedPrompt?: boolean | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export interface CommandBasedResult {
  stdout: string;
  stderr: string;
  usage?: TokenDelta | null;
  callResult: RunnerCallResult;
}

export interface CustomCommandBasedOptions {
  admission: AdmittedCustomRunnerInvocation;
  prompt: string;
  authorizationProjectDir: string;
  authorizationPathEnv?: string | undefined;
  authorizationPathExt?: string | undefined;
  cwd: string;
  sourceEnv: NodeJS.ProcessEnv;
  onOutput?: ((chunk: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
}

export type CustomCommandBasedTestSeam = Readonly<{
  hardDeadlineMs?: number | undefined;
}>;

export type CustomCommandBasedResult = Awaited<ReturnType<typeof spawnAndCollect>>;

let commandCallSequence = 0;

function rejectPromptPlaceholderCommand(command: string): void {
  if (!command.includes(PROMPT_PLACEHOLDER)) return;

  throw commandBasedInvocationError.promptPlaceholderInCommand(command);
}

function rejectShellEvaluatedPrompt(
  command: string,
  args: readonly string[],
  allowShellEvaluatedPrompt: boolean | undefined,
): void {
  if (allowShellEvaluatedPrompt) return;
  if (!isShellEvaluatedPromptArg(command, args)) return;

  throw commandBasedInvocationError.shellEvaluatedPrompt({ command, args });
}

function createCommandCallContext(opts: {
  command: string;
  callContext?: RunnerCallContext | undefined;
}): RunnerCallContext {
  return (
    opts.callContext ?? {
      callId: `command-${++commandCallSequence}`,
      role: 'planner',
      backendKind: 'shell',
      runnerName: opts.command,
    }
  );
}

function substitutePromptPlaceholder(
  command: string,
  args: string[],
  prompt: string,
): { command: string; args: string[]; useStdin: boolean } {
  const argsHavePlaceholder = args.some((a) => a.includes(PROMPT_PLACEHOLDER));

  if (!argsHavePlaceholder) {
    return { command, args, useStdin: true };
  }

  return {
    command,
    args: args.map((a) => a.replaceAll(PROMPT_PLACEHOLDER, () => prompt)),
    useStdin: false,
  };
}

async function invokeCustomCommandBasedRunnerWithDeadline(
  opts: CustomCommandBasedOptions,
  hardDeadlineMs: number,
): Promise<CustomCommandBasedResult> {
  const admission = parseAdmittedCustomRunnerInvocation(opts.admission);
  if (admission === null) {
    throw customRunnerAdmissionError.invalid();
  }
  if (Buffer.byteLength(opts.prompt, 'utf8') > CUSTOM_RUNNER_PROMPT_MAX_BYTES) {
    throw commandBasedInvocationError.customPromptTooLarge(CUSTOM_RUNNER_PROMPT_MAX_BYTES);
  }

  const environment = resolveCustomRunnerEnvironment(opts.sourceEnv, admission.runner.command.env);
  const redact = createCustomRunnerRedactor(environment.redactionValues);
  const executable = await revalidateCustomRunnerInvocation({
    invocation: admission,
    projectDir: opts.authorizationProjectDir,
    pathEnv: opts.authorizationPathEnv ?? '',
    pathExt: opts.authorizationPathExt ?? '',
  });

  return spawnAndCollect({
    command: executable.path,
    args: [...admission.runner.command.argv],
    cwd: opts.cwd,
    env: environment.env,
    stdin: opts.prompt,
    format: admission.runner.command.outputFormat,
    onText: opts.onOutput,
    onStderr: opts.onStderr,
    onSessionId: opts.onSessionId,
    onCallEvent: opts.onCallEvent,
    callContext: opts.callContext,
    signal: opts.signal,
    idle: {
      warnMs: admission.runner.command.idleWarnMs,
      killMs: admission.runner.command.idleKillMs,
    },
    outputBudgetBytes: CUSTOM_RUNNER_PROCESS_OUTPUT_MAX_BYTES,
    timeoutMs: hardDeadlineMs,
    credentialValues: environment.redactionValues,
    redact,
  });
}

/** Runs the already-admitted custom command through the no-shell process path. */
export function invokeCustomCommandBasedRunner(
  opts: CustomCommandBasedOptions,
): Promise<CustomCommandBasedResult> {
  return invokeCustomCommandBasedRunnerWithDeadline(opts, CUSTOM_RUNNER_HARD_DEADLINE_MS);
}

export function invokeCustomCommandBasedRunnerForTest(
  opts: CustomCommandBasedOptions,
  testSeam: CustomCommandBasedTestSeam,
): Promise<CustomCommandBasedResult> {
  return invokeCustomCommandBasedRunnerWithDeadline(
    opts,
    testSeam.hardDeadlineMs ?? CUSTOM_RUNNER_HARD_DEADLINE_MS,
  );
}

export async function invokeCommandBasedRunner(
  opts: CommandBasedOptions & {
    prompt: string;
    projectDir: string;
    onOutput?: ((chunk: string) => void) | undefined;
    onSessionId?: ((id: string) => void) | undefined;
    onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    callContext?: RunnerCallContext | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<CommandBasedResult> {
  const { prompt, projectDir, onOutput, signal } = opts;
  const rawArgs = opts.args ?? [];
  const format: OutputFormat = opts.outputFormat ?? 'text';
  const idleWarnMs = opts.idleWarnMs ?? RUNNER_IDLE_WARN_MS;
  const idleKillMs = opts.idleKillMs ?? RUNNER_IDLE_KILL_MS;

  rejectPromptPlaceholderCommand(opts.command);
  rejectShellEvaluatedPrompt(opts.command, rawArgs, opts.allowShellEvaluatedPrompt);

  let finalCommand = opts.command;
  let finalArgs = rawArgs;
  let useStdin = true;

  if (opts.supportPromptPlaceholder) {
    const substituted = substitutePromptPlaceholder(opts.command, rawArgs, prompt);
    finalCommand = substituted.command;
    finalArgs = substituted.args;
    useStdin = substituted.useStdin;
  }

  let stdout: string;
  let stderr = '';
  let usage: TokenDelta | null = null;
  let callResult: RunnerCallResult;
  const context = createCommandCallContext({
    command: finalCommand,
    callContext: opts.callContext,
  });

  if (opts.timeout !== undefined) {
    const parseLine = getLineParser(format);
    const credentialValues = credentialValuesFromEnvironment(opts.env ?? process.env);
    const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
    const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
    const recorder = createRunnerCallRecorder({
      context,
      credentialValues,
      onEvent: opts.onCallEvent,
    });
    const parsedRecorder = createParsedLineRecorder({
      recorder,
      onText: (text) => onOutput?.(redactCredential(text)),
      onSessionId: (id) => opts.onSessionId?.(redactCredential(id)),
    });
    const stderrBuffer = createRunnerCallStderrBuffer(recorder);
    const liveOutputBuffer = createLineBuffer(
      (line) => {
        parsedRecorder.apply(parseLine(line));
      },
      {
        maxLineBytes: DEFAULT_PROCESS_LINE_MAX_BYTES,
        onOverflow: (overflow) => {
          finishRunnerCallOutputLimit(
            recorder,
            runnerCallLineOutputLimit({
              code: 'stdout_line_overflow',
              label: 'stdout line',
              lineBytes: overflow.lineBytes,
              maxLineBytes: overflow.maxLineBytes,
            }),
            {
              usage: parsedRecorder.usage,
              nativeSessionId: parsedRecorder.sessionId,
            },
          );
        },
      },
    );
    try {
      const result = await spawnWithShellFallback({
        command: finalCommand,
        args: finalArgs,
        cwd: projectDir,
        env: opts.env,
        timeout: opts.timeout,
        onProgress: (chunk) => liveOutputBuffer.push(chunk),
        onStderr: (chunk) => stderrBuffer.push(chunk),
        stdinInput: useStdin ? prompt : undefined,
        notFoundMessage: opts.notFoundMessage,
        signal,
        idle: {
          warnMs: idleWarnMs,
          killMs: idleKillMs,
          onWarn: (silentMs) => recorder.stalled({ silentMs }),
          onClear: () => recorder.stallCleared(),
        },
      });
      liveOutputBuffer.flush();
      stderrBuffer.flush();

      if (result.timedOut) {
        recorder.finishFailed({
          status: 'timeout',
          error: {
            code: 'command_timeout',
            message: `Command timed out after ${opts.timeout}ms`,
          },
        });
        throw processError.timeout({
          command: 'Command',
          label: 'Command',
          timeoutMs: opts.timeout,
          output: redactCredential(result.output),
        });
      }

      stdout = parsedRecorder.text;
      usage = parsedRecorder.usage;
      stderr = result.stderr;
      if (!recorder.hasTerminal()) recorder.finishCompleted();
      callResult = recorder.finalResult();
    } catch (err) {
      liveOutputBuffer.flush();
      stderrBuffer.flush();
      if (!recorder.hasTerminal()) {
        if (processError.isIdleTimeout(err)) {
          recorder.finishFailed({
            status: 'failed',
            error: runnerCallIdleTimeoutError(err, credentialValues),
          });
        } else {
          recorder.finishFailed({
            status: signal?.aborted ? runnerCallInterruptedStatus(signal) : 'failed',
            error: {
              code: 'command_failed',
              message: boundedRunnerCallMessage(toErrorMessage(err), credentialValues),
            },
          });
        }
      }
      throw err;
    }
  } else {
    const stderrOutput = createBoundedOutput({
      maxBytes: DEFAULT_PROCESS_STDERR_MAX_BYTES,
      policy: 'tail',
    });
    const result = await spawnAndCollect({
      command: finalCommand,
      args: finalArgs,
      cwd: projectDir,
      env: opts.env,
      stdin: useStdin ? prompt : undefined,
      format,
      notFoundMessage: opts.notFoundMessage,
      onText: onOutput,
      onSessionId: opts.onSessionId,
      onCallEvent: opts.onCallEvent,
      callContext: context,
      signal,
      idle: { warnMs: idleWarnMs, killMs: idleKillMs },
      abortOnOutputLimits: false,
      onStderr: (chunk) => {
        stderrOutput.append(chunk);
      },
    });

    stdout = result.text;
    stderr = stderrOutput.snapshot().text;
    usage = toTokenDelta(result.usage);
    callResult = result;
  }

  return { stdout, stderr, usage, callResult };
}
