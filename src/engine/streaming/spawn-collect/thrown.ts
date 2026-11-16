import { processError } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { isRecord } from '../../../utils/type-guards.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  RUNNER_CALL_STOPPED_ERROR,
} from '../../calls/status.js';
import { customRunnerToolInputStateLimitError } from '../../runners/custom/tool-input-redaction.js';
import { spawnCollectError } from './cancellation.js';
import { flushStderr, flushStdout, toolInputCapacityExceeded } from './redacted-stream.js';
import type { CollectCall, CollectResult } from './types.js';

/**
 * The outcome of a call whose spawn threw: the result of a call that its tool-call limit stopped,
 * or the terminal record and the error that the caller gets.
 */
export function thrownCollectResult(call: CollectCall, err: unknown): CollectResult {
  const { stream, recorder, cancellation, credentialValues, redactCredential } = call;
  if (call.limitSignal.aborted) {
    flushStdout(stream);
    flushStderr(stream);
    return { ...recorder.finalResult(), sessionId: call.parsedRecorder.sessionId };
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
        command: redactCredential(call.command),
        label: 'Custom runner',
        timeoutMs: call.timeoutMs ?? 0,
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
