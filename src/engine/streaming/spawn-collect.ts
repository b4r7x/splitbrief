import type { OutputFormat } from '../../core/schemas/enums.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
} from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { ParsedLine, ParsedTextChannel } from '../runners/types.js';
import {
  createCustomRunnerStreamingRedactor,
  createCustomRunnerToolInputRedactor,
  customRunnerToolInputStateLimitError,
  customRunnerRedactionValuesFor,
  redactCustomRunnerParsedLine,
  type CustomRunnerRedactor,
} from '../runners/redaction.js';
import { processError } from '../../lib/process/errors.js';
import { spawnWithStdin } from '../../lib/process/spawn/line-stream.js';
import type { SpawnPipeFatalSignal } from '../../lib/process/spawn/lifecycle.js';
import { error, matches } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { isCredentialEnvironmentName, redactSecrets } from '../../utils/redact.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  finishRunnerCallOutputLimit,
  runnerCallLimitWarning,
  runnerCallLineOutputLimit,
  type RunnerCallOutputLimit,
} from '../calls/output-limit.js';
import { getLineParser } from './output-parsers.js';
import { createParsedLineRecorder } from './parsed-line-recorder.js';
import { createRunnerCallStderrBuffer } from './stderr-lines.js';
import { sandboxCredentialValues } from '../runners/sandbox-credential-values.js';
import { TASK_COMPILATION_FAILURE_CODE } from '../spec/tasks/task-compilation-codes.js';

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
  /**
   * Optional hard wall-clock deadline. The collector owns composition with an
   * external cancellation signal so the detached lifecycle reaps the process
   * tree for either outcome.
   */
  timeoutMs?: number | undefined;
  /** Redacts invocation-specific values before they reach controlled surfaces. */
  redact?: CustomRunnerRedactor | undefined;
}

let callSequence = 0;

export const spawnCollectError = {
  invalidHardDeadline: (timeoutMs: number) =>
    error(
      'runner-invalid-timeout',
      'Runner hard deadline must be a positive finite number of milliseconds.',
      { timeoutMs },
    ),
  redacted: <Kind extends string>(opts: { kind: Kind; message: string; data?: unknown }) =>
    error(opts.kind, opts.message, opts.data),
  isInvalidHardDeadline: matches('runner-invalid-timeout'),
} as const;

// `task_compiler_timeout` is deliberately not a teardown trigger: an envelope
// that can latch it has already clamped the hard deadline and the idle kill to
// the same bounds, so the cancellation is due before the latch can fire and it
// owns both the teardown and the terminal. Latching here as well would only
// race that cancellation and classify one deadline two ways.
function fatalLimitFromEvent(
  event: RunnerCallEvent,
  abortOnOutputLimits: boolean,
): RunnerCallOutputLimit | null {
  if (!abortOnOutputLimits || event.type !== 'call_warning') return null;
  const { code, message } = event.warning;
  if (
    code === TASK_COMPILATION_FAILURE_CODE.task_compiler_output_limited ||
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
    isRecord(err) && err.state === 'output-budget-breach' && typeof err.remediation === 'string'
  );
}

type InvocationCancellationSource = 'none' | 'external' | 'timeout';

type InvocationCancellation = Readonly<{
  signal: AbortSignal | undefined;
  source: () => InvocationCancellationSource;
  cleanup: () => void;
}>;

function createInvocationCancellation(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): InvocationCancellation {
  if (timeoutMs === undefined) {
    return {
      signal,
      source: () => (signal?.aborted ? 'external' : 'none'),
      cleanup: () => undefined,
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw spawnCollectError.invalidHardDeadline(timeoutMs);
  }

  const controller = new AbortController();
  let cancellation: InvocationCancellationSource = 'none';
  const abortForExternalSignal = () => {
    if (cancellation !== 'none') return;
    cancellation = 'external';
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) abortForExternalSignal();
  else signal?.addEventListener('abort', abortForExternalSignal, { once: true });

  const timer = setTimeout(() => {
    if (cancellation !== 'none') return;
    cancellation = 'timeout';
    controller.abort(new DOMException('Runner hard deadline exceeded.', 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    source: () => cancellation,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortForExternalSignal);
    },
  };
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
  const envelope = context.envelope;
  // The canonical envelope is the hard ceiling at the spawn boundary: the
  // absolute deadline drives the cancellation timer and the idle bound clamps
  // the watchdog kill, so a breach kills the tree instead of only latching
  // the recorder. Raw and normalized bounds latch in the recorder, whose
  // limit warnings tear the tree down through fatalLimitFromEvent.
  const envelopeDeadlineMs = envelope?.deadlineMs;
  const envelopeIdleMs = envelope?.idleTimeoutMs;
  const effectiveTimeoutMs =
    opts.timeoutMs === undefined
      ? envelopeDeadlineMs
      : envelopeDeadlineMs === undefined
        ? opts.timeoutMs
        : Math.min(opts.timeoutMs, envelopeDeadlineMs);
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => {
    const redactedCredentials = redactSecrets(explicitRedactor(value));
    return opts.redact?.(redactedCredentials) ?? redactedCredentials;
  };
  const cancellation = createInvocationCancellation(opts.signal, effectiveTimeoutMs);
  let fatalLimit: RunnerCallOutputLimit | null = null;
  const recorder = createRunnerCallRecorder({
    context,
    credentialValues,
    onEvent: (event) => {
      fatalLimit ??= fatalLimitFromEvent(event, abortOnOutputLimits);
      opts.onCallEvent?.(event);
    },
  });
  const protectedValues = [...credentialValues, ...customRunnerRedactionValuesFor(opts.redact)];
  const parsedRecorder = createParsedLineRecorder({
    recorder,
    onText: opts.onText,
    onSessionId: (id) => opts.onSessionId?.(redactCredential(id)),
  });
  const createStdoutRedactor = () =>
    createCustomRunnerStreamingRedactor(redactCredential, protectedValues);
  const toolInputRedactor =
    opts.redact === undefined
      ? undefined
      : createCustomRunnerToolInputRedactor(redactCredential, protectedValues);
  let toolInputCapacityExceeded = false;
  let stdoutRedactor = createStdoutRedactor();
  let stdoutChannel: ParsedTextChannel = 'stdout';
  const flushText = (): void => {
    const text = stdoutRedactor.flush();
    if (text.length > 0) parsedRecorder.apply({ text, channel: stdoutChannel });
  };
  const applyRedactedParsed = (parsed: ParsedLine): void => {
    const parsedText = parsed.text;
    const redacted =
      opts.redact === undefined ? parsed : redactCustomRunnerParsedLine(parsed, redactCredential);
    const channel = redacted.channel ?? (redacted.isResult ? 'result' : 'stdout');
    const isFinalBoundary = redacted.isResult === true || channel === 'result';
    const isStreamingText = channel === 'assistant' || channel === 'stdout';

    if (isFinalBoundary && parsedText !== undefined) {
      const terminal = stdoutRedactor.flushBeforeTerminal(parsedText);
      if (terminal.before.length > 0) {
        parsedRecorder.apply({ text: terminal.before, channel: stdoutChannel });
      }
      stdoutRedactor = createStdoutRedactor();
      parsedRecorder.apply({ ...redacted, text: terminal.value });
      return;
    } else if (redacted.isError === true || !isStreamingText) {
      flushText();
    }
    if (parsedText === undefined) {
      parsedRecorder.apply(redacted);
      return;
    }

    stdoutChannel = channel;
    const text =
      isFinalBoundary || !isStreamingText
        ? stdoutRedactor.push(parsedText) + stdoutRedactor.flush()
        : stdoutRedactor.push(parsedText);
    parsedRecorder.apply({ ...redacted, text });
  };
  const flushToolInput = (): void => {
    for (const parsed of toolInputRedactor?.flush() ?? []) {
      applyRedactedParsed(parsed);
    }
  };
  const flushStdout = (): void => {
    flushToolInput();
    flushText();
  };
  const applyParsed = (parsed: ParsedLine): void => {
    const redactedLines = toolInputRedactor?.apply(parsed);
    if (toolInputRedactor?.hasExceededCapacity() === true) {
      toolInputCapacityExceeded = true;
      return;
    }
    for (const redacted of redactedLines ?? [parsed]) {
      applyRedactedParsed(redacted);
    }
  };
  const stderrBuffer = createRunnerCallStderrBuffer(recorder);
  const stderrRedactor = createCustomRunnerStreamingRedactor(redactCredential, protectedValues);
  const emitStderr = (chunk: string): void => {
    if (chunk.length === 0) return;
    stderrBuffer.push(chunk);
    opts.onStderr?.(chunk);
  };
  const flushStderr = (): void => {
    emitStderr(stderrRedactor.flush());
    stderrBuffer.flush();
  };
  const fatalOutputSignal = (): SpawnPipeFatalSignal | undefined => {
    if (fatalLimit === null) return undefined;
    flushStdout();
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
  const toolInputCapacitySignal = (): SpawnPipeFatalSignal | undefined =>
    toolInputCapacityExceeded
      ? {
          state: 'protocol-failure',
          remediation: customRunnerToolInputStateLimitError().message,
        }
      : undefined;

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        emitStderr(stderrRedactor.push(chunk));
        return toolInputCapacitySignal() ?? fatalOutputSignal();
      },
      signal: cancellation.signal,
      idle: {
        warnMs:
          envelopeIdleMs === undefined
            ? (opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS)
            : Math.min(opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS, envelopeIdleMs),
        killMs:
          envelopeIdleMs === undefined
            ? (opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS)
            : Math.min(opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS, envelopeIdleMs),
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
        flushStdout();
        finishRunnerCallOutputLimit(recorder, limit, {
          usage: parsedRecorder.usage,
          nativeSessionId: parsedRecorder.sessionId,
        });
        return fatalOutputSignal();
      },
      onLine(line) {
        applyParsed(parseLine(line));
        return toolInputCapacitySignal() ?? fatalOutputSignal();
      },
    });
  } catch (err) {
    if (toolInputCapacityExceeded) {
      flushStderr();
      const stateLimitError = customRunnerToolInputStateLimitError();
      if (!recorder.hasTerminal()) {
        recorder.finishFailed({
          status: 'failed',
          error: runnerCallErrorFromUnknown(
            stateLimitError,
            'custom-runner-tool-input-state-limit',
            credentialValues,
          ),
          partial: false,
        });
      }
      throw stateLimitError;
    }
    flushStdout();
    flushStderr();
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
    const redactedError = redactThrownError(err, redactCredential);
    if (!recorder.hasTerminal()) {
      const cancellationSource = cancellation.source();
      if (cancellationSource === 'timeout') {
        const timeoutError = processError.timeout({
          command: redactCredential(opts.command),
          label: 'Custom runner',
          timeoutMs: effectiveTimeoutMs ?? 0,
          output: '',
        });
        recorder.finishFailed({
          status: 'timeout',
          error: runnerCallErrorFromUnknown(timeoutError, 'runner_timeout', credentialValues),
        });
        throw timeoutError;
      }
      if (processError.isIdleTimeout(redactedError)) {
        recorder.finishFailed({
          status: 'failed',
          error: runnerCallIdleTimeoutError(redactedError, credentialValues),
        });
      } else {
        const interrupted = cancellationSource === 'external';
        recorder.finishFailed({
          status: interrupted ? 'aborted' : 'failed',
          error: runnerCallErrorFromUnknown(
            redactedError,
            interrupted ? 'runner_interrupted' : 'runner_process_error',
            credentialValues,
          ),
        });
      }
    }
    throw redactedError;
  } finally {
    cancellation.cleanup();
  }

  flushStdout();
  flushStderr();
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

function redactThrownError(err: unknown, redactCredential: (value: string) => string): Error {
  const kind = isRecord(err) && typeof err.kind === 'string' ? err.kind : 'runner_process_error';
  const data =
    isRecord(err) && 'data' in err ? redactErrorValue(err.data, redactCredential) : undefined;
  const message = redactCredential(toErrorMessage(err));
  return spawnCollectError.redacted({ kind, message, ...(data === undefined ? {} : { data }) });
}

function redactErrorValue(
  value: unknown,
  redactCredential: (value: string) => string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactCredential(value);
  if (Array.isArray(value))
    return value.map((item) => redactErrorValue(item, redactCredential, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[redactCredential(key)] = redactErrorValue(item, redactCredential, seen);
  }
  return redacted;
}
