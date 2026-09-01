import type { ChildProcess } from 'node:child_process';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  finishRunnerCallOutputLimit,
  RUNNER_CALL_STDERR_MAX_BYTES,
  type RunnerCallOutputLimit,
} from '../../calls/output-limit.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallResult,
} from '../../calls/types.js';
import { TASK_COMPILATION_FAILURE_CODE } from '../../spec/tasks/task-compilation-codes.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  spawnPipe,
  spawnPipeError,
} from '../../../lib/process/spawn/lifecycle.js';
import { createLineBuffer } from '../../../lib/process/line-buffer.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { assertNever, isRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import { isCredentialEnvironmentName } from '../../../utils/redact.js';
import { sandboxCredentialValues } from '../sandbox-credential-values.js';
import { revalidateCliExecutableIdentity } from '../resolve-cli-executable.js';
import { type PreparedPrompt, preparePrompt } from './prompt-transport.js';
import type {
  CliInvocation,
  CliOutputContract,
  CliProcessAdapter,
  CliProtocolEvent,
} from './contract.js';

/**
 * Raw protocol traffic is not the text the recorder retains: a verbose
 * stream-json session carries envelope frames, partial-message deltas, and tool
 * result echoes that are a large multiple of the assistant text one call
 * produces. These ceilings only stop a runaway process; recorded output keeps
 * its own `RUNNER_CALL_OUTPUT_*` limits, which truncate instead of killing.
 */
export const CLI_RAW_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const CLI_RAW_PROTOCOL_MAX_EVENTS = 262_144;

type CliAdapter = CliProcessAdapter;

export type InvokeProcessCliContext = Readonly<{
  invocation: CliInvocation;
  prompt: string;
  callContext: RunnerCallContext;
  /**
   * Liveness is measured from process output, not from recorded events: a
   * runner can think for minutes while emitting frames that record nothing.
   */
  idle?: Readonly<{ warnMs: number; killMs: number }> | undefined;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
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
  let envelopeLimit: RunnerCallOutputLimit | null = null;
  let timeoutController: AbortController | undefined;
  let recorder: RunnerCallRecorder;
  try {
    recorder = createRunnerCallRecorder({
      context: context.callContext,
      credentialValues,
      onEvent: (event) => {
        // A canonical envelope byte breach latches in the recorder and surfaces
        // as this warning; tear the process tree down immediately so the hard
        // bound is enforced at spawn, not only recorded. The catch below
        // classifies the awaited abort as truncated with the latch code.
        // `task_compiler_timeout` is deliberately absent: the envelope deadline
        // already clamps the invocation timer and its idle bound clamps the
        // watchdog kill, so both own their teardown and classify as `timeout`.
        // Latching here would only race them and report a deadline breach as an
        // output limit.
        if (
          event.type === 'call_warning' &&
          event.warning.code === TASK_COMPILATION_FAILURE_CODE.task_compiler_output_limited
        ) {
          envelopeLimit = { code: event.warning.code, message: event.warning.message };
          timeoutController?.abort(
            new DOMException('CLI invocation envelope limit reached', 'TimeoutError'),
          );
        }
        try {
          context.onEvent?.(event);
        } catch (cause) {
          callbackFailed = true;
          throw cause;
        }
      },
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

  let prepared: PreparedPrompt;
  try {
    prepared = await preparePrompt(adapter, context.invocation, invocationArgs, context.prompt);
  } catch (cause) {
    return finishFailureSafely({
      recorder,
      context: context.callContext,
      credentialValues,
      status: 'failed',
      error: { code: prelaunchErrorCode(cause), message: prelaunchErrorMessage(cause) },
    });
  }

  const protocolEvents: CliProtocolEvent[] = [];
  let stderr = '';
  let eventCount = 0;
  let terminalSeen = false;
  const envelope = context.callContext.envelope;
  // The canonical envelope is the hard ceiling at the spawn boundary: its
  // deadline clamps the invocation timer and its raw protocol bound clamps the
  // spawn byte budget, so a breach kills the tree instead of only latching.
  timeoutController = new AbortController();
  const timeoutMs =
    envelope === undefined
      ? context.invocation.timeoutMs
      : Math.min(context.invocation.timeoutMs, envelope.deadlineMs);
  const timeout = setTimeout(
    () => timeoutController?.abort(new DOMException('CLI invocation timed out', 'TimeoutError')),
    timeoutMs,
  );
  timeout.unref?.();
  const signal = context.invocation.signal
    ? AbortSignal.any([context.invocation.signal, timeoutController.signal])
    : timeoutController.signal;

  const applyProtocolEvent = (event: CliProtocolEvent): void => {
    // A structured stream may restate its terminal result — Codex describes one
    // failure as an `error` record followed by `turn.failed` — and the adapter's
    // `terminal` reducer picks the authoritative one. Any non-result traffic
    // after a terminal result is still a protocol failure.
    if (terminalSeen && event.type !== 'result') {
      throw fatal('protocol-failure', 'CLI emitted output after its terminal result');
    }
    eventCount += 1;
    if (eventCount > CLI_RAW_PROTOCOL_MAX_EVENTS) {
      throw fatal('output-budget-breach', 'CLI protocol event budget was exceeded');
    }
    protocolEvents.push(event);
    switch (event.type) {
      case 'text':
        if (event.channel === 'stderr') recorder.stderr({ text: event.text });
        else {
          recorder.text({
            channel: event.channel,
            text: event.text,
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
      case 'tool-use':
        recorder.toolUseDone({
          toolUse: {
            id: event.id,
            name: event.name,
            input: { ...event.input },
            ...(event.output !== undefined && { output: event.output }),
          },
        });
        return;
      case 'warning':
        recorder.warning({
          warning: { code: event.code, source: 'provider', message: event.message },
        });
        return;
      case 'result':
        terminalSeen = true;
        return;
      default:
        assertNever(event);
    }
  };

  const lineBuffer = createLineBuffer(
    (line) => {
      let parsed: readonly CliProtocolEvent[];
      try {
        parsed = adapter.parse(line);
      } catch {
        throw fatal('protocol-failure', 'CLI output did not match its structured protocol');
      }
      for (const event of parsed) applyProtocolEvent(event);
    },
    {
      maxLineBytes: DEFAULT_PROCESS_LINE_MAX_BYTES,
      onOverflow: () => {
        throw fatal('output-budget-breach', 'CLI output line exceeded the line byte budget');
      },
    },
  );

  try {
    const executableState = await revalidateCliExecutableIdentity(context.invocation.executable);
    if (executableState !== 'match') {
      return executableState === 'missing'
        ? fail({
            recorder,
            status: 'failed',
            error: { code: 'spawn-not-found', message: 'Configured CLI executable was not found' },
          })
        : fail({
            recorder,
            status: 'failed',
            error: {
              code: 'cli-executable-identity-drift',
              message:
                'CLI executable identity changed; run readiness checks again before execution',
            },
          });
    }
    const closed = await spawnPipe<ProcessClose>({
      command: context.invocation.executable.path,
      args: prepared.args,
      cwd: context.invocation.cwd,
      env: { ...context.invocation.environment },
      detached: process.platform !== 'win32',
      stdin: prepared.stdin,
      signal,
      outputBudgetBytes:
        envelope === undefined
          ? CLI_RAW_OUTPUT_MAX_BYTES
          : Math.min(CLI_RAW_OUTPUT_MAX_BYTES, envelope.maxRawProtocolBytes),
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
          ...(envelope !== undefined && {
            warnMs: Math.min(context.idle.warnMs, envelope.idleTimeoutMs),
            killMs: Math.min(context.idle.killMs, envelope.idleTimeoutMs),
          }),
        },
      }),
      ...(context.onSpawned !== undefined && { onSpawned: context.onSpawned }),
      onStdout(chunk) {
        try {
          lineBuffer.push(chunk);
        } catch (cause) {
          return fatalSignal(cause, 'protocol-failure');
        }
        return undefined;
      },
      onStderr(chunk) {
        stderr += chunk;
        recorder.stderr({ text: chunk });
      },
      onClose(exitCode, processSignal) {
        lineBuffer.flush();
        return { exitCode, signal: processSignal, stderr };
      },
    });

    if (closed.signal !== null) {
      return fail({
        recorder,
        status: 'failed',
        error: { code: 'signal-exit', message: `CLI exited from signal ${closed.signal}` },
      });
    }
    if (adapter.outputContract.kind === 'structured-terminal' && !terminalSeen) {
      // Without a parsed terminal the exit code is the only diagnosis available.
      if (closed.exitCode !== 0) {
        return fail({
          recorder,
          status: 'failed',
          error: {
            code: 'non-zero-exit',
            message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
          },
        });
      }
      return fail({
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
      return fail({
        recorder,
        status: 'failed',
        error: { code: 'protocol-failure', message: 'CLI terminal result was invalid' },
      });
    }

    // A tool that fails its turn also exits non-zero; its parsed failure
    // terminal carries the tool's own diagnosis and outranks the bare exit
    // code — that diagnosis is what lets a quota or auth failure be classified
    // instead of hiding behind "CLI exited with code 1". A terminal claiming
    // success against a failure exit is contradictory, so that combination
    // stays on the exit code, fail-closed.
    if (isFailureExit(adapter.outputContract, closed.exitCode) && terminal.status === 'completed') {
      return fail({
        recorder,
        status: 'failed',
        error: {
          code: 'non-zero-exit',
          message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
        },
      });
    }

    if (terminal.text.length > 0) {
      recorder.text({ channel: 'result', text: terminal.text, semantics: 'final' });
    }
    if (terminal.status === 'completed') {
      return recorder.finishCompleted({
        usage: terminal.usage,
        nativeSessionId: terminal.nativeSessionId,
      });
    }
    return recorder.finishFailed({
      status: terminal.status,
      error: terminal.error,
      usage: terminal.usage,
      nativeSessionId: terminal.nativeSessionId,
      partial: terminal.partial,
    });
  } catch (cause) {
    if (callbackFailed) {
      return callbackFailure(context.callContext, credentialValues);
    }
    if (envelopeLimit !== null) {
      // The recorder latched the envelope breach before the awaited reap; the
      // terminal stays truncated with the canonical limit code and no later
      // record can clear it.
      return finishRunnerCallOutputLimit(recorder, envelopeLimit);
    }
    if (signal.aborted) {
      const status = runnerCallInterruptedStatus(signal);
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status,
        error: {
          code: status === 'timeout' ? 'timeout' : 'user-abort',
          message: status === 'timeout' ? 'CLI invocation timed out' : 'CLI invocation was aborted',
        },
      });
    }
    if (processError.isIdleTimeout(cause)) {
      // A silent runner is a timeout, not a protocol failure: the `timeout`
      // code is what the implementer pipeline classifies as retryable.
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'timeout',
        error: {
          code: 'timeout',
          message: runnerCallErrorFromUnknown(cause, 'timeout', credentialValues).message,
        },
      });
    }
    if (spawnPipeError.isStdinIncomplete(cause)) {
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: 'failed',
        error: {
          code: 'prompt-transport-error',
          message: 'CLI prompt could not be fully delivered through stdin',
        },
      });
    }
    const fatalState = fatalStateOf(cause);
    if (fatalState !== null) {
      // The spawn byte budget is clamped to the canonical envelope raw bound,
      // so its breach is the envelope raw breach: classify with the canonical
      // limit code instead of the transport backstop code.
      const code =
        fatalState === 'output-budget-breach' && envelope !== undefined
          ? TASK_COMPILATION_FAILURE_CODE.task_compiler_output_limited
          : fatalState;
      return finishFailureSafely({
        recorder,
        context: context.callContext,
        credentialValues,
        status: fatalState === 'output-budget-breach' ? 'truncated' : 'failed',
        error: { code, message: errorMessage(cause) },
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
      error: {
        code: 'protocol-failure',
        message: runnerCallErrorFromUnknown(cause, 'protocol-failure', credentialValues).message,
      },
    });
  } finally {
    clearTimeout(timeout);
    // The terminal result is already recorded; a scratch-directory removal failure
    // must not replace it with a throw.
    await prepared.cleanup().catch(() => {});
  }
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

function prelaunchErrorCode(cause: unknown): 'callback-failure' | 'prompt-transport-error' {
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
  if (isRecord(cause) && cause.kind === 'prompt-transport-error') {
    return typeof cause.message === 'string'
      ? cause.message
      : 'CLI prompt transport failed before launch';
  }
  return 'CLI pre-launch validation failed';
}
