import { processError } from '../../../../lib/process/errors.js';
import { spawnPipe } from '../../../../lib/process/spawn/lifecycle.js';
import { matches, error } from '../../../../utils/error.js';
import {
  RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
  RUNNER_CALL_STDERR_MAX_BYTES,
} from '../../../calls/output-limit.js';
import { createRunnerCallRecorder } from '../../../calls/recorder/create.js';
import type { SteeringPort } from '../../../calls/steering.js';
import type { RunnerCallEvent, RunnerCallResult } from '../../../calls/types.js';
import {
  revalidateCliExecutableIdentity,
  executableChangedMessage,
} from '../../cli-executable/identity.js';
import type { CliProcessAdapter, CliInvocation, CliSteeringTransport } from '../contract.js';
import { type PreparedPrompt, preparePrompt } from '../prompt-transport.js';
import { fail, prelaunchErrorCode, prelaunchErrorMessage } from './failures.js';
import { prelaunchProcessCli } from './prelaunch.js';
import { createProtocolEventLog } from './protocol-event.js';
import { closeAdmission, holdsTerminal, processOutput } from './stream.js';
import { closedCallFinish } from './terminal.js';
import { thrownCallResult, transportFailure } from './thrown.js';
import type { InvokeProcessCliContext, ProcessCall, ProcessClose } from './types.js';

type CliAdapter = CliProcessAdapter;

export async function invokeProcessCli(
  adapter: CliAdapter,
  context: InvokeProcessCliContext,
): Promise<RunnerCallResult> {
  const callback = { failed: false };
  const limit = new AbortController();
  const recordEvent = (event: RunnerCallEvent) => {
    try {
      context.onEvent?.(event);
    } catch (cause) {
      callback.failed = true;
      throw cause;
    }
  };
  const prelaunch = prelaunchProcessCli({
    adapter,
    invocation: context.invocation,
    callContext: context.callContext,
    maxToolCalls: context.maxToolCalls,
    onLimit: () => limit.abort(),
    onEvent: recordEvent,
  });
  if (!prelaunch.ok) return prelaunch.result;

  const timeoutController = new AbortController();
  const guard = new AbortController();
  const transport = new AbortController();
  const call: ProcessCall = {
    adapter,
    context,
    credentialValues: prelaunch.credentialValues,
    recordEvent,
    protocolEvents: createProtocolEventLog(RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES),
    inspectedInputs: new Map(),
    signal: AbortSignal.any([
      ...(context.invocation.signal === undefined ? [] : [context.invocation.signal]),
      timeoutController.signal,
      guard.signal,
      limit.signal,
      transport.signal,
    ]),
    guard,
    limit,
    transport,
    settle: new AbortController(),
    settled: new DOMException('CLI call settled on its result', 'AbortError'),
    callback,
    state: {
      recorder: prelaunch.recorder,
      steeringSession: undefined,
      detach: undefined,
      admissionClosed: false,
      stdoutLastLine: '',
      stdoutTailCarry: '',
      stderr: '',
      storedHalt: undefined,
      terminalSeen: false,
      graceTimer: undefined,
      guardFailure: null,
      removeTransportListener: undefined,
    },
  };
  // A seat call has no default total: only a configured `timeout` arms one.
  const timeoutMs = context.invocation.timeoutMs;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (holdsTerminal(call)) {
            call.settle.abort(call.settled);
            return;
          }
          timeoutController.abort(new DOMException('CLI invocation timed out', 'TimeoutError'));
        }, timeoutMs);
  timeout?.unref?.();
  const onAbort = () => {
    try {
      closeAdmission(call);
    } catch {
      callback.failed = true;
    }
  };
  call.signal.addEventListener('abort', onAbort, { once: true });
  if (call.signal.aborted) onAbort();

  try {
    const execution = await runProcess(call).then(
      (finish) => ({ status: 'fulfilled', finish }) as const,
      (cause: unknown) => ({ status: 'rejected', cause }) as const,
    );
    // The tool has closed, so its own outcome decides the call. A steering cleanup that outlasts the call timeout keeps that outcome.
    clearTimeout(timeout);
    try {
      try {
        closeAdmission(call);
      } finally {
        await call.state.steeringSession?.close();
      }
    } catch (cause) {
      return transportFailure(call, cause);
    }
    if (execution.status === 'rejected') throw execution.cause;
    call.signal.throwIfAborted();
    return execution.finish();
  } catch (cause) {
    return thrownCallResult(call, cause);
  } finally {
    call.signal.removeEventListener('abort', onAbort);
    call.state.removeTransportListener?.();
    clearTimeout(call.state.graceTimer);
  }
}

/**
 * Opens the steering session and attaches the port once the session is ready. A failure of the
 * steering transport aborts the call. Credential values of the session join the redaction
 * through a new recorder that keeps the start of the call.
 */
async function openSteering(
  call: ProcessCall,
  steering: CliSteeringTransport,
  port: SteeringPort,
  invocation: CliInvocation,
): Promise<CliInvocation> {
  const { context, state } = call;
  const session = await steering.open({
    invocation,
    prompt: context.prompt,
    onReady: (send) => {
      if (state.admissionClosed) return;
      state.detach = port.attach({
        callId: context.callContext.callId,
        role: context.callContext.role,
        taskId: context.callContext.taskId ?? null,
        send: (message) => (state.admissionClosed ? Promise.resolve('deferred') : send(message)),
      });
    },
    onAdmissionClosed: () => closeAdmission(call),
  });
  state.steeringSession = session;
  if (session.failureSignal !== undefined) {
    const failureSignal = session.failureSignal;
    const onFailure = () => call.transport.abort(failureSignal.reason);
    failureSignal.addEventListener('abort', onFailure, { once: true });
    state.removeTransportListener = () => failureSignal.removeEventListener('abort', onFailure);
    if (failureSignal.aborted) onFailure();
  }
  if (session.credentialValues !== undefined) {
    call.credentialValues.push(...session.credentialValues);
    state.recorder = createRunnerCallRecorder({
      context: context.callContext,
      startedAt: state.recorder.startedAt,
      credentialValues: call.credentialValues,
      stopAfterToolUses: context.maxToolCalls,
      onLimit: () => call.limit.abort(),
      onEvent: (event) => {
        if (event.type !== 'call_started') call.recordEvent(event);
      },
    });
  }
  return session.invocation;
}

/** Opens the steering session, prepares the prompt, then spawns the tool and reads its close. */
async function runProcess(call: ProcessCall): Promise<() => RunnerCallResult> {
  const { adapter, context, state } = call;
  let invocation: CliInvocation = { ...context.invocation, signal: call.signal };
  let prepared: PreparedPrompt;
  try {
    if (
      context.steering !== undefined &&
      adapter.steering?.supportsVersion(context.installedVersion)
    ) {
      invocation = await openSteering(call, adapter.steering, context.steering, invocation);
    }
    prepared = await preparePrompt(adapter, invocation, invocation.args, context.prompt);
  } catch (cause) {
    if (matches('platform-limitation')(cause)) throw cause;
    throw error(prelaunchErrorCode(cause), prelaunchErrorMessage(cause), undefined, cause);
  }
  call.signal.throwIfAborted();

  const output = processOutput(call);
  const executableState = await revalidateCliExecutableIdentity(invocation.executable);
  if (executableState !== 'match') {
    return () =>
      executableState === 'missing'
        ? fail({
            recorder: state.recorder,
            status: 'failed',
            error: {
              code: 'spawn-not-found',
              message: 'Configured CLI executable was not found',
            },
          })
        : fail({
            recorder: state.recorder,
            status: 'failed',
            error: {
              code: 'cli-executable-identity-drift',
              message: executableChangedMessage(adapter.descriptor.displayName),
            },
          });
  }
  const closed = await spawnPipe<ProcessClose>({
    command: invocation.executable.path,
    args: prepared.args,
    cwd: invocation.cwd,
    env: { ...invocation.environment },
    detached: process.platform !== 'win32',
    stdin: prepared.stdin,
    onStdinReady: state.steeringSession?.onStdinReady,
    signal: AbortSignal.any([call.signal, call.settle.signal]),
    // The recorder owns every retained byte of this call and nothing here
    // reads the spawn-level stdout snapshot, so a rolling megabyte tail of a
    // multi-megabyte protocol stream would be pure cost.
    partialStdoutMaxBytes: 0,
    partialStderrMaxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
    ...(context.idle !== undefined && {
      idle: {
        ...context.idle,
        // The idle diagnostic is reported to the user verbatim, and every
        // other diagnostic in this file names the tool, not the resolved
        // binary path (which carries the OS user's home directory).
        label: adapter.descriptor.id,
        onWarn: (silentMs) => state.recorder.stalled({ silentMs }),
        onClear: () => state.recorder.stallCleared(),
      },
    }),
    onSpawned:
      state.steeringSession === undefined
        ? context.onSpawned
        : (proc) => {
            proc.once('exit', () => {
              try {
                closeAdmission(call);
              } catch {
                call.callback.failed = true;
                call.guard.abort();
              }
            });
            context.onSpawned?.(proc);
          },
    ...output,
  }).catch((cause: unknown) => {
    // The stop after the result is SPLITBRIEF's, so it is not a failed exit of the tool. An idle
    // cut inside the grace stopped the tool group the same way.
    if (cause === call.settled || (holdsTerminal(call) && processError.isIdleTimeout(cause))) {
      return { exitCode: 0, signal: null, stderr: state.stderr };
    }
    throw cause;
  });
  return closedCallFinish(call, closed);
}
