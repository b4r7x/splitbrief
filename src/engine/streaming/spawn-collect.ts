import type { OutputFormat } from '../../core/schemas/enums.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { ParsedLine } from '../runners/types.js';
import { processError } from '../../lib/process/errors.js';
import { spawnWithStdin } from '../../lib/process/spawn/line-stream.js';
import type { SpawnPipeFatalSignal } from '../../lib/process/spawn/lifecycle.js';
import { isCredentialEnvironmentName, redactSecrets } from '../../utils/redact.js';
import {
  finishRunnerCallOutputLimit,
  runnerCallLimitWarning,
  runnerCallLineOutputLimit,
  type RunnerCallOutputLimit,
} from '../calls/output-limit.js';
import { getLineParser } from './output-parsers.js';
import { createParsedLineRecorder } from './parsed-line-recorder.js';
import { createRunnerCallStderrBuffer } from './stderr-lines.js';
import { sandboxCredentialValues } from '../runners/sandbox-env.js';

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  parseLine?: ((line: string) => ParsedLine) | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
  // Defaults are applied here in spawnAndCollect, the single defaulting site —
  // callers pass configured overrides through.
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
  stdoutLineMaxBytes?: number | undefined;
  outputBudgetBytes?: number | undefined;
  /**
   * Tear the child down when its output breaches a recorded limit or a channel
   * retention bound (default). Callers that keep collecting past the bounds turn
   * this off; the call is then warned about, not truncated.
   */
  abortOnOutputLimits?: boolean | undefined;
  /** Credential values are passed explicitly so callbacks never receive raw secrets. */
  credentialValues?: readonly string[] | undefined;
}

let callSequence = 0;

function fatalLimitFromEvent(
  event: RunnerCallEvent,
  abortOnOutputLimits: boolean,
): RunnerCallOutputLimit | null {
  if (!abortOnOutputLimits || event.type !== 'call_warning') return null;
  const { code, message } = event.warning;
  if (
    code === 'runner_output_text_limit' ||
    code === 'stdout_line_overflow' ||
    code === 'stderr_line_overflow' ||
    (code.startsWith('runner_call_') && code.endsWith('_limit'))
  ) {
    return { code, message };
  }
  return null;
}

function isOutputBudgetFatalSignal(
  err: unknown,
): err is SpawnPipeFatalSignal & { state: 'output-budget-breach' } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'state' in err &&
    err.state === 'output-budget-breach' &&
    'remediation' in err &&
    typeof err.remediation === 'string'
  );
}

export async function spawnAndCollect(
  opts: SpawnAndCollectOptions,
): Promise<RunnerCallResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');
  const context =
    opts.callContext ??
    ({
      callId: `call-${++callSequence}`,
      role: 'implementer',
      backendKind: 'cli',
      runnerName: opts.command,
    } satisfies RunnerCallContext);

  const credentialValues =
    opts.credentialValues ?? credentialValuesFromEnvironment(opts.env ?? process.env);
  const abortOnOutputLimits = opts.abortOnOutputLimits ?? true;
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
  let fatalLimit: RunnerCallOutputLimit | null = null;
  const recorder = createRunnerCallRecorder({
    context,
    credentialValues,
    onEvent: (event) => {
      fatalLimit ??= fatalLimitFromEvent(event, abortOnOutputLimits);
      opts.onCallEvent?.(event);
    },
  });
  const parsedRecorder = createParsedLineRecorder({
    recorder,
    onText: (text) => opts.onText?.(redactCredential(text)),
    onSessionId: (id) => opts.onSessionId?.(redactCredential(id)),
  });
  const stderrBuffer = createRunnerCallStderrBuffer(recorder);
  const fatalOutputSignal = (): SpawnPipeFatalSignal | undefined => {
    if (fatalLimit === null) return undefined;
    if (!recorder.hasTerminal()) {
      recorder.finishFailed({
        status: 'truncated',
        error: { code: fatalLimit.code, message: fatalLimit.message },
        usage: parsedRecorder.usage,
        nativeSessionId: parsedRecorder.sessionId,
        partial: true,
      });
    }
    return { state: 'output-budget-breach', remediation: fatalLimit.message };
  };

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        stderrBuffer.push(chunk);
        opts.onStderr?.(redactCredential(chunk));
        return fatalOutputSignal();
      },
      signal: opts.signal,
      idle: {
        warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
        killMs: opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS,
        onWarn: (silentMs) => recorder.stalled({ silentMs }),
        onClear: () => recorder.stallCleared(),
      },
      outputMaxBytes: opts.outputMaxBytes,
      stderrMaxBytes: opts.stderrMaxBytes,
      stdoutLineMaxBytes: opts.stdoutLineMaxBytes,
      outputBudgetBytes: opts.outputBudgetBytes,
      abortOnByteLimit: abortOnOutputLimits,
      onStdoutLineOverflow: (overflow) => {
        const limit = runnerCallLineOutputLimit({
          code: 'stdout_line_overflow',
          label: 'stdout line',
          lineBytes: overflow.lineBytes,
          maxLineBytes: overflow.maxLineBytes,
        });
        // The opt-out caller keeps collecting: only the overlong line is lost,
        // and it asked for output limits not to tear its process down.
        if (!abortOnOutputLimits) {
          recorder.warning({ warning: runnerCallLimitWarning(limit) });
          return undefined;
        }
        fatalLimit = limit;
        finishRunnerCallOutputLimit(recorder, limit, {
          usage: parsedRecorder.usage,
          nativeSessionId: parsedRecorder.sessionId,
        });
        return fatalOutputSignal();
      },
      onLine(line) {
        parsedRecorder.apply(parseLine(line));
        return fatalOutputSignal();
      },
    });
  } catch (err) {
    stderrBuffer.flush();
    if (isOutputBudgetFatalSignal(err)) {
      if (!recorder.hasTerminal()) {
        const limit = fatalLimit ?? {
          code: 'runner_process_output_limit',
          message: err.remediation,
        };
        finishRunnerCallOutputLimit(recorder, limit, {
          usage: parsedRecorder.usage,
          nativeSessionId: parsedRecorder.sessionId,
        });
      }
      const result = recorder.finalResult();
      return { ...result, sessionId: parsedRecorder.sessionId };
    }
    if (!recorder.hasTerminal()) {
      if (processError.isIdleTimeout(err)) {
        recorder.finishFailed({
          status: 'failed',
          error: runnerCallIdleTimeoutError(err, credentialValues),
        });
      } else {
        recorder.finishFailed({
          status: opts.signal?.aborted ? runnerCallInterruptedStatus(opts.signal) : 'failed',
          error: runnerCallErrorFromUnknown(
            err,
            opts.signal?.aborted ? 'runner_interrupted' : 'runner_process_error',
            credentialValues,
          ),
        });
      }
    }
    throw redactThrownError(err, redactCredential);
  }

  stderrBuffer.flush();
  if (!recorder.hasTerminal()) {
    recorder.finishCompleted({ nativeSessionId: parsedRecorder.sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId: parsedRecorder.sessionId };
}

export function credentialValuesFromEnvironment(environment: NodeJS.ProcessEnv): readonly string[] {
  const values = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && isCredentialEnvironmentName(name))
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined && value.length > 0);
  return [...new Set([...values, ...sandboxCredentialValues(environment)])];
}

function redactThrownError(err: unknown, redactCredential: (value: string) => string): unknown {
  if (!(err instanceof Error)) return err;
  err.message = redactCredential(err.message);
  if (processError.isExitCode(err)) {
    err.data.stderr = redactCredential(err.data.stderr);
    err.data.output = redactCredential(err.data.output);
  }
  return err;
}
