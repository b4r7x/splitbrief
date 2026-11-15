import type { OutputFormat } from '../../../core/schemas/enums.js';
import { RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner/fields.js';
import { processError } from '../../../lib/process/errors.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { isRecord } from '../../../utils/type-guards.js';
import { createRunnerCallId } from '../../calls/call-id.js';
import { createRunnerCallRecorder } from '../../calls/recorder/create.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  RUNNER_CALL_STOPPED_ERROR,
} from '../../calls/status.js';
import type { RunnerCallEvent, RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import type { TextChunkMarks } from '../../events/types.js';
import type { CustomRunnerRedactor } from '../../runners/custom/redaction.js';
import { customRunnerToolInputStateLimitError } from '../../runners/custom/tool-input-redaction.js';
import { credentialValuesFromEnvironment } from '../../runners/sandbox/credential-values.js';
import type { ParsedLine } from '../../runners/types.js';
import { getLineParser } from '../parse/select.js';
import { createParsedLineRecorder } from '../parsed-line-recorder.js';
import { createInvocationCancellation, spawnCollectError } from './cancellation.js';
import {
  applyParsed,
  createRedactedStream,
  flushStderr,
  flushStdout,
  pushStderr,
  toolInputCapacityExceeded,
  toolInputCapacitySignal,
} from './redacted-stream.js';

interface SpawnAndCollectOptions {
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  parseLine?: ((line: string) => ParsedLine) | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string, marks?: TextChunkMarks) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
  // Defaults are applied here in spawnAndCollect, the single defaulting site —
  // callers pass configured overrides through.
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
  /** The seat's opt-in `maxToolCalls`; unset, no tool-call count ends the call. */
  maxToolCalls?: number | undefined;
  outputMaxBytes?: number | undefined;
  stderrMaxBytes?: number | undefined;
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

export async function spawnAndCollect(
  opts: SpawnAndCollectOptions,
): Promise<RunnerCallResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');
  const context =
    opts.callContext ??
    ({
      callId: createRunnerCallId('call'),
      role: 'implementer',
      backendKind: 'cli',
      runnerName: opts.command,
      axes: [],
    } satisfies RunnerCallContext);

  const credentialValues =
    opts.credentialValues ?? credentialValuesFromEnvironment(opts.env ?? process.env);
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => {
    const redactedCredentials = redactSecrets(explicitRedactor(value));
    return opts.redact?.(redactedCredentials) ?? redactedCredentials;
  };
  const limitController = new AbortController();
  const cancellation = createInvocationCancellation(
    opts.signal === undefined
      ? limitController.signal
      : AbortSignal.any([opts.signal, limitController.signal]),
    opts.timeoutMs,
  );
  const recorder = createRunnerCallRecorder({
    context,
    credentialValues,
    stopAfterToolUses: opts.maxToolCalls,
    onLimit: () => limitController.abort(),
    onEvent: (event) => opts.onCallEvent?.(event),
  });
  const parsedRecorder = createParsedLineRecorder({
    recorder,
    onText: opts.onText,
    onSessionId: (id) => opts.onSessionId?.(redactCredential(id)),
  });
  const stream = createRedactedStream({
    redact: opts.redact,
    redactCredential,
    credentialValues,
    recorder,
    parsedRecorder,
    onStderr: opts.onStderr,
  });

  try {
    await spawnWithStdin({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      notFoundMessage: opts.notFoundMessage,
      onStderr: (chunk) => {
        pushStderr(stream, chunk);
        return toolInputCapacitySignal(stream);
      },
      signal: cancellation.signal,
      idle: {
        warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
        killMs: opts.idle?.killMs,
        onWarn: (silentMs) => recorder.stalled({ silentMs }),
        onClear: () => recorder.stallCleared(),
      },
      outputMaxBytes: opts.outputMaxBytes,
      stderrMaxBytes: opts.stderrMaxBytes,
      onLine(line) {
        applyParsed(stream, parseLine(line));
        return toolInputCapacitySignal(stream);
      },
    });
  } catch (err) {
    if (limitController.signal.aborted) {
      flushStdout(stream);
      flushStderr(stream);
      return { ...recorder.finalResult(), sessionId: parsedRecorder.sessionId };
    }
    if (toolInputCapacityExceeded(stream)) {
      flushStderr(stream);
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
    flushStdout(stream);
    flushStderr(stream);
    const redactedError = redactThrownError(err, redactCredential);
    if (!recorder.hasTerminal()) {
      const cancellationSource = cancellation.source();
      if (cancellationSource === 'timeout') {
        const timeoutError = processError.timeout({
          command: redactCredential(opts.command),
          label: 'Custom runner',
          timeoutMs: opts.timeoutMs ?? 0,
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
        recorder.finishFailed(
          interrupted
            ? { status: 'aborted', error: RUNNER_CALL_STOPPED_ERROR }
            : {
                status: 'failed',
                error: runnerCallErrorFromUnknown(
                  redactedError,
                  'runner_process_error',
                  credentialValues,
                ),
              },
        );
      }
    }
    // The redaction rewrap above erases the `AbortError` identity the caller aborted with, so
    // every upstream classifier would read a user stop as a runner failure. Re-issue the abort
    // under the code they match on, keeping the redacted message.
    if (cancellation.source() === 'external') {
      throw error('operation-aborted', redactCredential(toErrorMessage(redactedError)));
    }
    throw redactedError;
  } finally {
    cancellation.cleanup();
  }

  flushStdout(stream);
  flushStderr(stream);
  if (!recorder.hasTerminal()) {
    recorder.finishCompleted({ nativeSessionId: parsedRecorder.sessionId });
  }

  const result = recorder.finalResult();
  return { ...result, sessionId: parsedRecorder.sessionId };
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
