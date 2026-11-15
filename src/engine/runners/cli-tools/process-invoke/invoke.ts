import type { ChildProcess } from 'node:child_process';
import { classifyHaltSignature } from '../../../../core/pipeline-spec/halts.js';
import { processError, timedOutMessage } from '../../../../lib/process/errors.js';
import { createLineBuffer } from '../../../../lib/process/line-buffer.js';
import { spawnPipeError } from '../../../../lib/process/spawn/fatal.js';
import { spawnPipe } from '../../../../lib/process/spawn/lifecycle.js';
import { isENOENT } from '../../../../utils/errno.js';
import { matches, error } from '../../../../utils/error.js';
import {
  RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
  RUNNER_CALL_STDERR_MAX_BYTES,
} from '../../../calls/output-limit.js';
import { createRunnerCallRecorder } from '../../../calls/recorder/create.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallInterruptedStatus,
  RUNNER_CALL_STOPPED_ERROR,
  runnerCallIdleTimeoutError,
} from '../../../calls/status.js';
import type { SteeringPort } from '../../../calls/steering.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../../calls/types.js';
import {
  revalidateCliExecutableIdentity,
  executableChangedMessage,
} from '../../cli-executable/identity.js';
import type {
  CliProcessAdapter,
  CliInvocation,
  CliSteeringSession,
  CliProtocolEvent,
} from '../contract.js';
import { type PreparedPrompt, preparePrompt } from '../prompt-transport.js';
import {
  finishFailureSafely,
  fail,
  prelaunchErrorCode,
  prelaunchErrorMessage,
  fatal,
  fatalSignal,
  haltFailure,
  isFailureExit,
  namesHalt,
  HALT_FAILURES,
  callbackFailure,
  fatalStateOf,
  errorMessage,
} from './failures.js';
import { prelaunchProcessCli } from './prelaunch.js';
import { createProtocolEventLog, recordCliProtocolEvent } from './protocol-event.js';

type CliAdapter = CliProcessAdapter;

/**
 * The time a structured tool gets to exit by itself after its terminal result, so its exit code
 * and stderr still decide the call. SPLITBRIEF then stops the tool, and the call keeps the result.
 */
const TERMINAL_EXIT_GRACE_MS = 2_000;

/**
 * Inspects one tool call as the stream reports it: once when its start and its
 * end carry the same input, and again when the end brings an input the start
 * lacked — Claude Code opens a call with none. A returned error stops the call
 * through the same abort that ends a cancelled one and becomes the call's
 * failure, so a tool call that crossed the caller's boundary is not left to
 * run on.
 */
export type ToolUseGuard = (
  toolUse: Readonly<{ name: string; input: Readonly<Record<string, unknown>> }>,
) => Readonly<{ code: string; message: string }> | null;

export type InvokeProcessCliContext = Readonly<{
  invocation: CliInvocation;
  prompt: string;
  steering?: SteeringPort | undefined;
  installedVersion?: string | undefined;
  callContext: RunnerCallContext;
  /**
   * Liveness is measured from process output, not from recorded events: a
   * runner can think for minutes while emitting frames that record nothing.
   */
  idle?: Readonly<{ warnMs: number; killMs?: number | undefined }> | undefined;
  /** The seat's opt-in `maxToolCalls`; unset, no tool-call count ends the call. */
  maxToolCalls?: number | undefined;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  toolUseGuard?: ToolUseGuard | undefined;
  /**
   * Optional lifecycle hook used by callers that need to observe the exact spawned child.
   * `spawnPipe` owns the failure boundary: a throw is converted to callback-failure and the
   * process tree is reaped before this invocation resolves.
   */
  onSpawned?: ((process: ChildProcess) => void) | undefined;
}>;

type ProcessClose = Readonly<{
  exitCode: number | null;
  signal: string | null;
  stderr: string;
}>;

export async function invokeProcessCli(
  adapter: CliAdapter,
  context: InvokeProcessCliContext,
): Promise<RunnerCallResult> {
  let callbackFailed = false;
  const limitController = new AbortController();
  const recordEvent = (event: RunnerCallEvent) => {
    try {
      context.onEvent?.(event);
    } catch (cause) {
      callbackFailed = true;
      throw cause;
    }
  };
  const prelaunch = prelaunchProcessCli({
    adapter,
    invocation: context.invocation,
    callContext: context.callContext,
    maxToolCalls: context.maxToolCalls,
    onLimit: () => limitController.abort(),
    onEvent: recordEvent,
  });
  if (!prelaunch.ok) return prelaunch.result;
  const { credentialValues } = prelaunch;
  let recorder = prelaunch.recorder;

  let prepared: PreparedPrompt | undefined;
  let steeringSession: CliSteeringSession | undefined;
  let detach: (() => void) | undefined;
  let admissionClosed = false;
  const closeAdmission = () => {
    if (admissionClosed) return;
    admissionClosed = true;
    const release = detach;
    detach = undefined;
    try {
      steeringSession?.onAdmissionClosed?.();
    } finally {
      release?.();
    }
  };
  const protocolEvents = createProtocolEventLog(RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES);
  let stdoutLastLine = '';
  let stdoutTailCarry = '';
  let stderr = '';
  let storedHalt: { code: string; message: string } | undefined;
  let terminalSeen = false;
  // Once a structured call holds its terminal result, that result decides the call: a configured
  // timeout or an idle cut that fires after it stops the tool and keeps the result.
  const holdsTerminal = () => terminalSeen && adapter.outputContract.kind === 'structured-terminal';
  const settle = new AbortController();
  const settled = new DOMException('CLI call settled on its result', 'AbortError');
  let graceTimer: NodeJS.Timeout | undefined;
  const timeoutController = new AbortController();
  // A seat call has no default total: only a configured `timeout` arms one.
  const timeoutMs = context.invocation.timeoutMs;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (holdsTerminal()) {
            settle.abort(settled);
            return;
          }
          timeoutController.abort(new DOMException('CLI invocation timed out', 'TimeoutError'));
        }, timeoutMs);
  timeout?.unref?.();
  const guardController = new AbortController();
  let guardFailure: ReturnType<ToolUseGuard> = null;
  const inspectedInputs = new Map<string, string>();
  const needsInspection = (event: Readonly<{ id: string | null; input: unknown }>): boolean => {
    if (event.id === null) return true;
    const input = JSON.stringify(event.input);
    if (inspectedInputs.get(event.id) === input) return false;
    inspectedInputs.set(event.id, input);
    return true;
  };
  const transportController = new AbortController();
  let removeTransportListener: (() => void) | undefined;
  let cleanupFailed = false;
  const signal = AbortSignal.any([
    ...(context.invocation.signal === undefined ? [] : [context.invocation.signal]),
    timeoutController.signal,
    guardController.signal,
    limitController.signal,
    transportController.signal,
  ]);
  const onAbort = () => {
    try {
      closeAdmission();
    } catch {
      callbackFailed = true;
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const execute = async (): Promise<() => RunnerCallResult> => {
    let invocation: CliInvocation = { ...context.invocation, signal };
    try {
      if (
        context.steering !== undefined &&
        adapter.steering?.supportsVersion(context.installedVersion)
      ) {
        const port = context.steering;
        steeringSession = await adapter.steering.open({
          invocation,
          prompt: context.prompt,
          onReady: (send) => {
            if (admissionClosed) return;
            detach = port.attach({
              callId: context.callContext.callId,
              role: context.callContext.role,
              taskId: context.callContext.taskId ?? null,
              send: (message) => (admissionClosed ? Promise.resolve('deferred') : send(message)),
            });
          },
          onAdmissionClosed: closeAdmission,
        });
        invocation = steeringSession.invocation;
        if (steeringSession.failureSignal !== undefined) {
          const failureSignal = steeringSession.failureSignal;
          const onFailure = () => transportController.abort(failureSignal.reason);
          failureSignal.addEventListener('abort', onFailure, { once: true });
          removeTransportListener = () => failureSignal.removeEventListener('abort', onFailure);
          if (failureSignal.aborted) onFailure();
        }
        if (steeringSession.credentialValues !== undefined) {
          credentialValues.push(...steeringSession.credentialValues);
          recorder = createRunnerCallRecorder({
            context: context.callContext,
            startedAt: recorder.startedAt,
            credentialValues,
            stopAfterToolUses: context.maxToolCalls,
            onLimit: () => limitController.abort(),
            onEvent: (event) => {
              if (event.type !== 'call_started') recordEvent(event);
            },
          });
        }
      }
      prepared = await preparePrompt(adapter, invocation, invocation.args, context.prompt);
    } catch (cause) {
      if (matches('platform-limitation')(cause)) throw cause;
      throw error(prelaunchErrorCode(cause), prelaunchErrorMessage(cause), undefined, cause);
    }
    signal.throwIfAborted();

    const applyProtocolEvent = (event: CliProtocolEvent, turnBoundary: boolean): void => {
      // A structured stream may restate its terminal result — Codex describes one
      // failure as an `error` record followed by `turn.failed` — and the adapter's
      // `terminal` reducer picks the authoritative one. Any non-result traffic
      // after a terminal result is still a protocol failure.
      if (terminalSeen && event.type !== 'result') {
        throw fatal('CLI emitted output after its terminal result');
      }
      protocolEvents.push(event);
      if (
        event.type === 'tool-use' &&
        guardFailure === null &&
        context.toolUseGuard !== undefined &&
        needsInspection(event)
      ) {
        guardFailure = context.toolUseGuard(event);
        if (guardFailure !== null) guardController.abort();
      }
      if (event.type === 'result') terminalSeen = !turnBoundary;
      recordCliProtocolEvent(recorder, event);
    };

    const parse = steeringSession?.parse ?? adapter.createParser?.() ?? adapter.parse;
    const lineBuffer = createLineBuffer((line) => {
      if (settle.signal.aborted) return;
      let parsed: readonly CliProtocolEvent[];
      try {
        parsed = parse(line);
      } catch {
        throw fatal('CLI output did not match its structured protocol');
      }
      // A line the parser drops, such as the tool's echo of the prompt, is not the tool's words.
      stdoutLastLine = parsed.length === 0 ? '' : line;
      const turnBoundary = steeringSession?.onLine(line, parsed) ?? false;
      for (const event of parsed) applyProtocolEvent(event, turnBoundary);
      // A steered tool keeps running after its result: a background task can open a new turn on
      // its own. The call settles on that result at once, and SPLITBRIEF stops the tool unread.
      if (steeringSession !== undefined && terminalSeen) settle.abort(settled);
      else if (holdsTerminal()) {
        graceTimer ??= setTimeout(() => settle.abort(settled), TERMINAL_EXIT_GRACE_MS);
      }
    });

    const executableState = await revalidateCliExecutableIdentity(invocation.executable);
    if (executableState !== 'match') {
      return () =>
        executableState === 'missing'
          ? fail({
              recorder,
              status: 'failed',
              error: {
                code: 'spawn-not-found',
                message: 'Configured CLI executable was not found',
              },
            })
          : fail({
              recorder,
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
      onStdinReady: steeringSession?.onStdinReady,
      signal: AbortSignal.any([signal, settle.signal]),
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
          onWarn: (silentMs) => recorder.stalled({ silentMs }),
          onClear: () => recorder.stallCleared(),
        },
      }),
      onSpawned:
        steeringSession === undefined
          ? context.onSpawned
          : (proc) => {
              proc.once('exit', () => {
                try {
                  closeAdmission();
                } catch {
                  callbackFailed = true;
                  guardController.abort();
                }
              });
              context.onSpawned?.(proc);
            },
      onStdout(chunk) {
        stdoutTailCarry = (stdoutTailCarry + chunk).split('\n').at(-1) ?? '';
        try {
          lineBuffer.push(chunk);
        } catch (cause) {
          closeAdmission();
          return fatalSignal(cause);
        }
        return undefined;
      },
      onStderr(chunk) {
        stderr += chunk;
        recorder.stderr({ text: chunk });
        if (terminalSeen) return undefined;
        const halt = haltFailure(stderr);
        if (halt !== null && (halt.code === 'usage-limit' || halt.code === 'unauthenticated')) {
          storedHalt = halt;
          return { state: 'protocol-failure', remediation: halt.message };
        }
        return undefined;
      },
      onClose(exitCode, processSignal) {
        closeAdmission();
        lineBuffer.flush();
        stdoutTailCarry = '';
        return { exitCode, signal: processSignal, stderr };
      },
    }).catch((cause: unknown) => {
      // The stop after the result is SPLITBRIEF's, so it is not a failed exit of the tool. An idle
      // cut inside the grace stopped the tool group the same way.
      if (cause === settled || (holdsTerminal() && processError.isIdleTimeout(cause))) {
        return { exitCode: 0, signal: null, stderr };
      }
      throw cause;
    });
    // The process can finish on its own before the guard's abort reaches it.
    if (guardFailure !== null) {
      const failure = guardFailure;
      return () => fail({ recorder, status: 'failed', error: failure });
    }

    if (closed.signal !== null) {
      return () =>
        fail({
          recorder,
          status: 'failed',
          error: haltFailure(stderr, [stdoutLastLine, stdoutTailCarry]) ?? {
            code: 'signal-exit',
            message: `CLI exited from signal ${closed.signal}`,
          },
        });
    }
    if (adapter.outputContract.kind === 'structured-terminal' && !terminalSeen) {
      // Without a parsed terminal the exit code is the only diagnosis available.
      if (closed.exitCode !== 0) {
        return () =>
          fail({
            recorder,
            status: 'failed',
            error: haltFailure(stderr, [stdoutLastLine, stdoutTailCarry]) ?? {
              code: 'non-zero-exit',
              message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
            },
          });
      }
      // The tool printed no terminal, so its diagnostic channel decides. Only stderr counts
      // here: stdout frames can restate the model's prose.
      const stderrHalt = haltFailure(closed.stderr);
      if (stderrHalt !== null) return () => fail({ recorder, status: 'failed', error: stderrHalt });
      return () =>
        fail({
          recorder,
          status: 'incomplete',
          error: {
            code: 'protocol-failure',
            message: 'CLI ended without its required terminal result',
          },
        });
    }

    let terminal: Extract<CliProtocolEvent, { type: 'result' }>;
    try {
      terminal = adapter.terminal({
        outputContract: adapter.outputContract,
        events: protocolEvents.events(),
        stderr: closed.stderr,
        exitCode: closed.exitCode,
        signal: closed.signal,
      });
    } catch {
      return () =>
        fail({
          recorder,
          status: 'failed',
          error: { code: 'protocol-failure', message: 'CLI terminal result was invalid' },
        });
    }

    // A failure exit preserves a text-exit answer only when it ends the stream without a halt.
    // Parsed failures keep their diagnosis; structured success against a failure exit fails closed.
    if (isFailureExit(adapter.outputContract, closed.exitCode) && terminal.status === 'completed') {
      const halt = haltFailure(stderr, [stdoutLastLine, stdoutTailCarry]);
      if (halt !== null) return () => fail({ recorder, status: 'failed', error: halt });
      const last = protocolEvents.events().at(-1);
      if (
        adapter.outputContract.kind === 'text-exit' &&
        terminal.text.length > 0 &&
        last?.type === 'text' &&
        (last.channel === 'assistant' || last.channel === 'result')
      ) {
        recorder.warning({
          warning: {
            code: 'non_zero_exit_after_answer',
            source: 'system',
            message: `CLI exited with code ${closed.exitCode ?? 'unknown'} after its final answer; the answer is kept`,
          },
        });
      } else {
        return () =>
          fail({
            recorder,
            status: 'failed',
            error: {
              code: 'non-zero-exit',
              message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
            },
          });
      }
    }

    if (terminal.text.length > 0) {
      recorder.text({ channel: 'result', text: terminal.text, semantics: 'final' });
    }
    if (terminal.status === 'completed') {
      return () =>
        recorder.finishCompleted({
          usage: terminal.usage,
          nativeSessionId: terminal.nativeSessionId,
          ...(terminal.structured !== undefined && { structured: terminal.structured }),
        });
    }
    // A failed terminal that names no halt of its own leaves the diagnosis to stderr.
    const stderrHalt = namesHalt(terminal.error) ? null : haltFailure(closed.stderr);
    // A tool refuses an oversized prompt or a model it cannot serve as an ordinary failed result
    // (Claude Code: "Prompt is too long"; OpenCode: `provider.no-route`). No later reader looks at
    // those words again, so the refusal takes the halt's code here.
    const refusal = classifyHaltSignature([terminal.error.message]);
    const refusalCode =
      refusal === 'input-too-large' || refusal === 'missing-model'
        ? HALT_FAILURES[refusal].code
        : undefined;
    return () =>
      recorder.finishFailed({
        status: stderrHalt === null && refusalCode === undefined ? terminal.status : 'failed',
        error:
          refusalCode !== undefined
            ? { ...terminal.error, code: refusalCode }
            : (stderrHalt ?? terminal.error),
        usage: terminal.usage,
        nativeSessionId: terminal.nativeSessionId,
        partial: terminal.partial,
      });
  };

  try {
    const execution = await execute().then(
      (finish) => ({ status: 'fulfilled', finish }) as const,
      (cause: unknown) => ({ status: 'rejected', cause }) as const,
    );
    // The tool has closed, so its own outcome decides the call. A steering cleanup that outlasts the call timeout keeps that outcome.
    clearTimeout(timeout);
    try {
      try {
        closeAdmission();
      } finally {
        await steeringSession?.close();
      }
    } catch (cause) {
      cleanupFailed = true;
      throw cause;
    }
    if (execution.status === 'rejected') throw execution.cause;
    signal.throwIfAborted();
    return execution.finish();
  } catch (cause) {
    if (cleanupFailed || matches('platform-limitation')(cause)) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: runnerCallErrorFromUnknown(cause, 'steering-transport-error', credentialValues),
      });
    }
    if (callbackFailed) {
      return callbackFailure(context.callContext, credentialValues);
    }
    if (guardFailure !== null) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: guardFailure,
      });
    }
    if (steeringSession?.failureSignal?.aborted) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: runnerCallErrorFromUnknown(
          steeringSession.failureSignal.reason,
          'steering-transport-error',
          credentialValues,
        ),
      });
    }
    if (signal.aborted) {
      const status = runnerCallInterruptedStatus(signal);
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status,
        error:
          status === 'timeout'
            ? {
                code: 'timeout',
                message:
                  timeoutMs === undefined
                    ? 'CLI invocation timed out'
                    : timedOutMessage(adapter.descriptor.displayName, timeoutMs),
              }
            : RUNNER_CALL_STOPPED_ERROR,
      });
    }
    if (processError.isIdleTimeout(cause)) {
      // A call cut by its opt-in `idleKillMs` made no progress. It stays a
      // failed attempt with the `no-progress-cut` code, which the ladder counts
      // toward the consecutive-timeouts halt the same way as `timeout`.
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: runnerCallIdleTimeoutError(cause, credentialValues),
      });
    }
    if (spawnPipeError.isStdinIncomplete(cause)) {
      // A tool that quits on its own error (a usage limit, a dead login) before it
      // reads its prompt breaks the pipe under that prompt. Its failed exit and its
      // words are the diagnosis, as for any failed exit. A tool that exits 0 may have
      // answered a cut prompt, and a tool SPLITBRIEF had to stop gave no exit, so for
      // these the pipe stays the cause.
      const ownExitCode = cause.data?.code;
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error:
          haltFailure(stderr, [stdoutLastLine, stdoutTailCarry]) ??
          (typeof ownExitCode === 'number' && ownExitCode !== 0
            ? { code: 'non-zero-exit', message: `CLI exited with code ${ownExitCode}` }
            : {
                code: 'prompt-transport-error',
                message: `CLI prompt could not be fully delivered through stdin${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
              }),
      });
    }
    if (storedHalt !== undefined) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: storedHalt,
      });
    }
    const fatalState = fatalStateOf(cause);
    if (fatalState !== null) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: { code: fatalState, message: errorMessage(cause) },
      });
    }
    if (isENOENT(cause)) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: { code: 'spawn-not-found', message: 'Configured CLI executable was not found' },
      });
    }
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues,
      status: 'failed',
      error: runnerCallErrorFromUnknown(cause, 'protocol-failure', credentialValues),
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    removeTransportListener?.();
    clearTimeout(graceTimer);
    onAbort();
  }
}
