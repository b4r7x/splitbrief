import { processError, timedOutMessage } from '../../../../lib/process/errors.js';
import { spawnPipeError } from '../../../../lib/process/spawn/fatal.js';
import { isENOENT } from '../../../../utils/errno.js';
import { matches } from '../../../../utils/error.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallInterruptedStatus,
  RUNNER_CALL_STOPPED_ERROR,
  runnerCallIdleTimeoutError,
} from '../../../calls/status.js';
import type { RunnerCallFailureStatus, RunnerCallResult } from '../../../calls/types.js';
import {
  callbackFailure,
  errorMessage,
  fatalStateOf,
  finishFailureSafely,
  haltFailure,
} from './failures.js';
import type { ProcessCall } from './types.js';

function failCall(
  call: ProcessCall,
  status: RunnerCallFailureStatus,
  error: { code: string; message: string },
): RunnerCallResult {
  return finishFailureSafely({
    recorder: call.state.recorder,
    context: call.context.callContext,
    credentialValues: call.credentialValues,
    status,
    error,
  });
}

/** A steering cleanup that failed, or a platform that cannot stop the tool, ends the call. */
export function transportFailure(call: ProcessCall, cause: unknown): RunnerCallResult {
  return failCall(
    call,
    'failed',
    runnerCallErrorFromUnknown(cause, 'steering-transport-error', call.credentialValues),
  );
}

/** The result of a call that threw: the first cause in this order that holds names the failure. */
export function thrownCallResult(call: ProcessCall, cause: unknown): RunnerCallResult {
  const { adapter, context, credentialValues, signal, state } = call;
  if (matches('platform-limitation')(cause)) return transportFailure(call, cause);
  if (call.callback.failed) return callbackFailure(context.callContext, credentialValues);
  if (state.guardFailure !== null) return failCall(call, 'failed', state.guardFailure);
  if (state.steeringSession?.failureSignal?.aborted) {
    return failCall(
      call,
      'failed',
      runnerCallErrorFromUnknown(
        state.steeringSession.failureSignal.reason,
        'steering-transport-error',
        credentialValues,
      ),
    );
  }
  if (signal.aborted) {
    const status = runnerCallInterruptedStatus(signal);
    const timeoutMs = context.invocation.timeoutMs;
    return failCall(
      call,
      status,
      status === 'timeout'
        ? {
            code: 'timeout',
            message:
              timeoutMs === undefined
                ? 'CLI invocation timed out'
                : timedOutMessage(adapter.descriptor.displayName, timeoutMs),
          }
        : RUNNER_CALL_STOPPED_ERROR,
    );
  }
  if (processError.isIdleTimeout(cause)) {
    // A call cut by its opt-in `idleKillMs` made no progress. It stays a
    // failed attempt with the `no-progress-cut` code, which the ladder counts
    // toward the consecutive-timeouts halt the same way as `timeout`.
    return failCall(call, 'failed', runnerCallIdleTimeoutError(cause, credentialValues));
  }
  if (spawnPipeError.isStdinIncomplete(cause)) {
    // A tool that quits on its own error (a usage limit, a dead login) before it
    // reads its prompt breaks the pipe under that prompt. Its failed exit and its
    // words are the diagnosis, as for any failed exit. A tool that exits 0 may have
    // answered a cut prompt, and a tool SPLITBRIEF had to stop gave no exit, so for
    // these the pipe stays the cause.
    const ownExitCode = cause.data?.code;
    return failCall(
      call,
      'failed',
      haltFailure(state.stderr, [state.stdoutLastLine, state.stdoutTailCarry]) ??
        (typeof ownExitCode === 'number' && ownExitCode !== 0
          ? { code: 'non-zero-exit', message: `CLI exited with code ${ownExitCode}` }
          : {
              code: 'prompt-transport-error',
              message: `CLI prompt could not be fully delivered through stdin${state.stderr.trim() === '' ? '' : `: ${state.stderr.trim()}`}`,
            }),
    );
  }
  if (state.storedHalt !== undefined) return failCall(call, 'failed', state.storedHalt);
  const fatalState = fatalStateOf(cause);
  if (fatalState !== null) {
    return failCall(call, 'failed', { code: fatalState, message: errorMessage(cause) });
  }
  if (isENOENT(cause)) {
    return failCall(call, 'failed', {
      code: 'spawn-not-found',
      message: 'Configured CLI executable was not found',
    });
  }
  return failCall(
    call,
    'failed',
    runnerCallErrorFromUnknown(cause, 'protocol-failure', credentialValues),
  );
}
