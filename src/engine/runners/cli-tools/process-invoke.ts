import type { ChildProcess } from 'node:child_process';
import type { SteeringPort } from '../../calls/steering.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  RUNNER_CALL_STDERR_MAX_BYTES,
  runnerCallLimitWarning,
  runnerCallLineOutputLimit,
} from '../../calls/output-limit.js';
import {
  RUNNER_CALL_STOPPED_ERROR,
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import {
  classifyHaltSignature,
  HALT_SIGNATURES,
  type HaltKind,
} from '../../../core/pipeline-spec/halts.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallResult,
} from '../../calls/types.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  spawnPipe,
  spawnPipeError,
} from '../../../lib/process/spawn/lifecycle.js';
import { createLineBuffer, type LineBufferOverflow } from '../../../lib/process/line-buffer.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { assertNever, isRecord } from '../../../utils/type-guards.js';
import { error, matches } from '../../../utils/error.js';
import { isCredentialEnvironmentName } from '../../../utils/redact.js';
import { sandboxCredentialValues } from '../sandbox-credential-values.js';
import { classifySeatFailure } from '../seat-failure.js';
import {
  executableChangedMessage,
  revalidateCliExecutableIdentity,
} from '../resolve-cli-executable.js';
import { type PreparedPrompt, preparePrompt } from './prompt-transport.js';
import type {
  CliInvocation,
  CliOutputContract,
  CliProcessAdapter,
  CliProtocolEvent,
  CliSteeringSession,
} from './contract.js';

/**
 * Raw protocol traffic is not the text the recorder retains: a verbose
 * stream-json session carries envelope frames, partial-message deltas, and tool
 * result echoes that are a large multiple of the assistant text one call
 * produces. These ceilings only stop a runaway process; recorded output keeps
 * its own `RUNNER_CALL_OUTPUT_*` limits, which truncate instead of killing.
 */
export const CLI_RAW_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

type CliAdapter = CliProcessAdapter;

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

export function recordCliProtocolEvent(
  recorder: RunnerCallRecorder,
  event: CliProtocolEvent,
): void {
  switch (event.type) {
    case 'text':
      if (event.channel === 'stderr') recorder.stderr({ text: event.text });
      else {
        recorder.text({
          channel: event.channel,
          text: event.text,
          ...(event.subagentId !== undefined && { subagentId: event.subagentId }),
          ...(event.semantics !== undefined && { semantics: event.semantics }),
        });
      }
      return;
    case 'usage':
      recorder.usage({ usage: event.usage, semantics: event.semantics });
      return;
    case 'session':
      recorder.sessionId({ nativeSessionId: event.nativeSessionId });
      return;
    case 'tool-use-delta':
      recorder.toolUseDelta({
        toolUseId: event.id,
        name: event.name,
        inputDelta: event.inputDelta,
      });
      return;
    case 'tool-use':
      if (event.stage === 'started') {
        recorder.toolUseDelta({
          toolUseId: event.id,
          name: event.name,
          inputDelta: JSON.stringify(event.input),
          stage: 'started',
        });
      } else {
        recorder.toolUseDone({
          toolUse: {
            id: event.id,
            name: event.name,
            input: { ...event.input },
            ...(event.output !== undefined && { output: event.output }),
          },
        });
      }
      return;
    case 'warning':
      recorder.warning({
        warning: {
          code: event.code,
          source: 'provider',
          message: event.message,
          ...(event.severity !== undefined && { severity: event.severity }),
          ...(event.originalModel !== undefined && { originalModel: event.originalModel }),
          ...(event.fallbackModel !== undefined && { fallbackModel: event.fallbackModel }),
        },
      });
      return;
    case 'heartbeat':
      recorder.heartbeat();
      return;
    case 'input-ack':
    case 'result':
      return;
    default:
      assertNever(event);
  }
}

export async function invokeProcessCli(
  adapter: CliAdapter,
  context: InvokeProcessCliContext,
): Promise<RunnerCallResult> {
  let credentialValues: string[];
  try {
    credentialValues = selectedCredentialValues(adapter, context.invocation.environment);
  } catch {
    const recorder = createRunnerCallRecorder({ context: context.callContext });
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues: [],
      status: 'failed',
      error: { code: 'callback-failure', message: 'Runner adapter setup failed' },
    });
  }
  let callbackFailed = false;
  const limitController = new AbortController();
  let recorder: RunnerCallRecorder;
  const recordEvent = (event: RunnerCallEvent) => {
    try {
      context.onEvent?.(event);
    } catch (cause) {
      callbackFailed = true;
      throw cause;
    }
  };
  try {
    recorder = createRunnerCallRecorder({
      context: context.callContext,
      credentialValues,
      onLimit: () => limitController.abort(),
      onEvent: recordEvent,
    });
  } catch {
    recorder = createRunnerCallRecorder({ context: context.callContext, credentialValues });
    return fail({
      recorder,
      status: 'failed',
      error: { code: 'callback-failure', message: 'Runner event callback failed' },
    });
  }

  const invocationArgs = [...context.invocation.args];

  let validation: unknown;
  try {
    // An invocation that declares no adapter-owned prefix carries no configured
    // arguments, so the whole argv is the prefix and nothing needs scrutiny.
    validation = adapter.validateArgs({
      invocationArgs,
      baseArgs: context.invocation.baseArgs ?? invocationArgs,
    });
  } catch {
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues,
      status: 'failed',
      error: { code: 'callback-failure', message: 'CLI argument validation failed' },
    });
  }

  const normalizedValidation = normalizeCliArgumentValidation(validation);
  if (normalizedValidation === null) {
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues,
      status: 'failed',
      error: {
        code: 'callback-failure',
        message: 'CLI argument validation returned an invalid result',
      },
    });
  }

  if (!normalizedValidation.valid) {
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues,
      status: 'failed',
      error: {
        code: 'argument-conflict',
        message: `CLI arguments conflict with the adapter contract: ${formatArgumentConflicts(normalizedValidation.conflicts)}`,
      },
    });
  }

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
  const protocolEvents: CliProtocolEvent[] = [];
  let stdoutLastLine = '';
  let stdoutTailCarry = '';
  let stderr = '';
  let terminalSeen = false;
  const timeoutController = new AbortController();
  // A seat call has no default total: only a configured `timeout` arms one.
  const timeoutMs = context.invocation.timeoutMs;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            timeoutController.abort(new DOMException('CLI invocation timed out', 'TimeoutError')),
          timeoutMs,
        );
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
  // Halt phrases are the tool's own words for giving up, so only its
  // diagnostic channel and the last line it printed are candidates: the
  // transcript above that line is the model's prose, where a path under
  // `billing/` or a shelled-out `permission denied` is ordinary task output.
  const haltLines = (): readonly string[] => [
    ...stderr.split('\n'),
    stdoutLastLine,
    stdoutTailCarry,
  ];

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
            onLimit: () => limitController.abort(),
            onEvent: (event) => {
              if (event.type !== 'call_started') recordEvent(event);
            },
          });
        }
      }
      prepared = await preparePrompt(
        adapter,
        invocation,
        invocation.args,
        steeringSession?.prompt ??
          (adapter.encodePrompt === undefined
            ? context.prompt
            : await adapter.encodePrompt({ invocation, prompt: context.prompt })),
      );
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
        throw fatal('protocol-failure', 'CLI emitted output after its terminal result');
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
    const lineBufferOptions = {
      maxLineBytes: DEFAULT_PROCESS_LINE_MAX_BYTES,
      onOverflow: (overflow: LineBufferOverflow) => {
        recorder.warning({
          warning: runnerCallLimitWarning(
            runnerCallLineOutputLimit({
              code: 'stdout_line_overflow',
              label: 'stdout line',
              lineBytes: overflow.lineBytes,
              maxLineBytes: overflow.maxLineBytes,
            }),
          ),
        });
        return undefined;
      },
    };
    const allowInputEcho = (input: string) => {
      lineBufferOptions.maxLineBytes = Math.max(
        lineBufferOptions.maxLineBytes,
        Buffer.byteLength(input, 'utf8') + DEFAULT_PROCESS_LINE_MAX_BYTES,
      );
    };
    const onStdinReady = steeringSession?.onStdinReady;
    if (onStdinReady !== undefined) allowInputEcho(prepared.stdin ?? '');
    const lineBuffer = createLineBuffer((line) => {
      let parsed: readonly CliProtocolEvent[];
      try {
        parsed = parse(line);
      } catch {
        throw fatal('protocol-failure', 'CLI output did not match its structured protocol');
      }
      const turnBoundary = terminalSeen ? false : (steeringSession?.onLine(line, parsed) ?? false);
      for (const event of parsed) applyProtocolEvent(event, turnBoundary);
    }, lineBufferOptions);

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
      onStdinReady:
        onStdinReady === undefined
          ? undefined
          : (writer) =>
              onStdinReady({
                write: (input) => {
                  allowInputEcho(input);
                  return writer.write(input);
                },
                end: () => writer.end(),
              }),
      signal,
      outputBudgetBytes: CLI_RAW_OUTPUT_MAX_BYTES,
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
        const parts = (stdoutTailCarry + chunk).split('\n');
        stdoutTailCarry = parts.pop() ?? '';
        const lastComplete = parts.at(-1);
        if (lastComplete !== undefined) stdoutLastLine = lastComplete;
        try {
          lineBuffer.push(chunk);
        } catch (cause) {
          closeAdmission();
          return fatalSignal(cause, 'protocol-failure');
        }
        return undefined;
      },
      onStderr(chunk) {
        stderr += chunk;
        recorder.stderr({ text: chunk });
      },
      onClose(exitCode, processSignal) {
        closeAdmission();
        lineBuffer.flush();
        return { exitCode, signal: processSignal, stderr };
      },
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
          error: haltFailure(haltLines()) ?? {
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
            error: haltFailure(haltLines()) ?? {
              code: 'non-zero-exit',
              message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
            },
          });
      }
      // The tool printed no terminal, so its diagnostic channel decides. Only stderr counts
      // here: stdout frames can restate the model's prose.
      const stderrHalt = haltFailure(closed.stderr.split('\n'));
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
        events: protocolEvents,
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
      const halt = haltFailure(haltLines());
      if (halt !== null) return () => fail({ recorder, status: 'failed', error: halt });
      const last = protocolEvents.at(-1);
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
    const stderrHalt = namesHalt(terminal.error) ? null : haltFailure(closed.stderr.split('\n'));
    return () =>
      recorder.finishFailed({
        status: stderrHalt === null ? terminal.status : 'failed',
        error: stderrHalt ?? terminal.error,
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
            ? { code: 'timeout', message: 'CLI invocation timed out' }
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
      // A tool that quits on a usage limit or a dead login before it reads its
      // prompt breaks the pipe under that prompt; its own words are the
      // diagnosis, and they keep the halt and the seat-switch offer it earns.
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: haltFailure(haltLines()) ?? {
          code: 'prompt-transport-error',
          message: 'CLI prompt could not be fully delivered through stdin',
        },
      });
    }
    const fatalState = fatalStateOf(cause);
    if (fatalState !== null) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: fatalState === 'output-budget-breach' ? 'truncated' : 'failed',
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
    clearTimeout(timeout);
    onAbort();
    await prepared?.cleanup().catch(() => {});
  }
}

/**
 * A halt phrase in the tail of a failed CLI run outranks the bare exit code:
 * the ladder must not spend retries on a signed-out, out-of-quota, unknown-model
 * or malformed-recipe process. The matched line is the diagnostic, so the user
 * reads the tool's own words.
 */
const HALT_FAILURES: Readonly<Record<HaltKind, { code: string; phrases: readonly string[] }>> = {
  'input-too-large': { code: 'input-too-large', phrases: HALT_SIGNATURES.inputTooLarge },
  auth: { code: 'unauthenticated', phrases: HALT_SIGNATURES.auth },
  usage: { code: 'usage-limit', phrases: HALT_SIGNATURES.usage },
  'missing-model': { code: 'missing-model', phrases: HALT_SIGNATURES.missingModel },
  spawn: { code: 'implementer-recipe-invalid', phrases: HALT_SIGNATURES.spawnFailure },
};

function haltFailure(lines: readonly string[]): { code: string; message: string } | null {
  const kind = classifyHaltSignature(lines);
  if (kind === null) return null;
  const { code, phrases } = HALT_FAILURES[kind];
  const matched = lines.find((line) =>
    phrases.some((phrase) => line.toLowerCase().includes(phrase)),
  );
  return { code, message: matched?.trim() ?? code };
}

const HALT_CODES: ReadonlySet<string> = new Set(
  Object.values(HALT_FAILURES).map((failure) => failure.code),
);

/** A failed terminal whose own words already name a halt keeps them over anything on stderr. */
function namesHalt(
  failure: Readonly<{
    code: string;
    message: string;
    status?: number | undefined;
    providerType?: string | undefined;
  }>,
): boolean {
  return (
    HALT_CODES.has(failure.code) ||
    haltFailure([failure.message]) !== null ||
    classifySeatFailure({
      message: failure.message,
      ...(failure.status !== undefined && { status: failure.status }),
      ...(failure.providerType !== undefined && { providerType: failure.providerType }),
      source: 'result-error',
    }).class !== 'other'
  );
}

function callbackFailure(
  context: RunnerCallContext,
  credentialValues: readonly string[],
): RunnerCallResult {
  return fail({
    recorder: createRunnerCallRecorder({ context, credentialValues }),
    status: 'failed',
    error: { code: 'callback-failure', message: 'Runner event callback failed' },
  });
}

function finishFailureSafely(input: {
  recorder: RunnerCallRecorder;
  context: RunnerCallContext;
  credentialValues: readonly string[];
  status: RunnerCallFailureStatus;
  error: { code: string; message: string };
}): RunnerCallResult {
  const { recorder, context, credentialValues, status, error: failure } = input;
  try {
    return fail({ recorder, status, error: failure });
  } catch {
    // Consumer callbacks are untrusted code. If one throws while the terminal failure is being
    // emitted, finish through a recorder without that callback rather than leaking a raw throw.
    return fail({
      recorder: createRunnerCallRecorder({ context, credentialValues }),
      status,
      error: failure,
    });
  }
}

type CliArgumentValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; conflicts: readonly string[] }>;

function normalizeCliArgumentValidation(value: unknown): CliArgumentValidation | null {
  try {
    if (!isRecord(value) || typeof value.valid !== 'boolean') return null;
    if (value.valid) return { valid: true };
    if (
      !Array.isArray(value.conflicts) ||
      !value.conflicts.every((conflict) => typeof conflict === 'string' && conflict.length > 0)
    ) {
      return null;
    }
    return { valid: false, conflicts: [...value.conflicts] };
  } catch {
    return null;
  }
}

function formatArgumentConflicts(conflicts: readonly string[]): string {
  return conflicts
    .map((conflict) => {
      // Protected flags are useful remediation; arbitrary values can contain credentials,
      // account data, or absolute paths and therefore stay out of terminal diagnostics.
      if (/^-{1,2}[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(conflict)) return conflict;
      return '[redacted argument]';
    })
    .join(', ');
}

function selectedCredentialValues(
  adapter: CliAdapter,
  environment: Readonly<Record<string, string>>,
): string[] {
  const declaredNames = new Set(adapter.descriptor.auth.channels.flatMap((channel) => channel.env));
  const values: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (declaredNames.has(name) || isCredentialEnvironmentName(name)) values.push(value);
  }
  values.push(...sandboxCredentialValues(environment));
  return [...new Set(values)];
}

function fail(input: {
  recorder: RunnerCallRecorder;
  status: RunnerCallFailureStatus;
  error: { code: string; message: string };
}): RunnerCallResult {
  return input.recorder.finishFailed({ status: input.status, error: input.error });
}

function isFailureExit(contract: CliOutputContract, exitCode: number | null): boolean {
  switch (contract.kind) {
    case 'text-exit':
      return !contract.successfulExitCodes.includes(exitCode ?? -1);
    case 'structured-terminal':
      return exitCode !== 0;
    default:
      return assertNever(contract);
  }
}

function fatal(state: 'output-budget-breach' | 'protocol-failure', message: string): Error {
  const cause = error(state, message);
  Object.assign(cause, { state, remediation: message });
  return cause;
}

function fatalSignal(
  cause: unknown,
  fallback: 'output-budget-breach' | 'protocol-failure',
): {
  state: 'output-budget-breach' | 'protocol-failure' | 'callback-failure';
  remediation: string;
} {
  return { state: fatalStateOf(cause) ?? fallback, remediation: errorMessage(cause) };
}

function fatalStateOf(
  cause: unknown,
): 'output-budget-breach' | 'protocol-failure' | 'callback-failure' | null {
  if (!isRecord(cause)) return null;
  const state = cause.state;
  if (
    state === 'output-budget-breach' ||
    state === 'protocol-failure' ||
    state === 'callback-failure'
  ) {
    return state;
  }
  return null;
}

function prelaunchErrorCode(
  cause: unknown,
): 'callback-failure' | 'prompt-transport-error' | 'steering-transport-error' {
  if (isRecord(cause) && cause.kind === 'steering-transport-error') return cause.kind;
  return isRecord(cause) && cause.kind === 'prompt-transport-error'
    ? 'prompt-transport-error'
    : 'callback-failure';
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause) && typeof cause.remediation === 'string') {
    return cause.remediation;
  }
  return 'CLI process invocation failed';
}

function prelaunchErrorMessage(cause: unknown): string {
  if (
    isRecord(cause) &&
    cause.kind === 'steering-transport-error' &&
    typeof cause.message === 'string'
  ) {
    return cause.message;
  }
  if (isRecord(cause) && cause.kind === 'prompt-transport-error') {
    return typeof cause.message === 'string'
      ? cause.message
      : 'CLI prompt transport failed before launch';
  }
  return 'CLI pre-launch validation failed';
}
