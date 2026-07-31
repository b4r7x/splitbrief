import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_EVENTS,
  RUNNER_CALL_STDERR_MAX_BYTES,
} from '../../calls/output-limit.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
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
import { isENOENT } from '../../../lib/process/errors.js';
import { isRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { sandboxCredentialValues } from '../sandbox-env.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
  CliProtocolEvent,
} from './contract.js';

const PROMPT_PLACEHOLDER = '<PROMPT>';
const PROMPT_FILE_NAME = 'prompt.txt';

type CliAdapter = CliPlannerAdapter | CliImplementerAdapter;

export type InvokeProcessCliContext = Readonly<{
  invocation: CliInvocation;
  prompt: string;
  callContext: RunnerCallContext;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  /**
   * Optional lifecycle hook used by callers that need to observe the exact spawned child.
   * `spawnPipe` owns the failure boundary: a throw is converted to callback-failure and the
   * process tree is reaped before this invocation resolves.
   */
  onSpawned?: ((process: ChildProcess) => void) | undefined;
}>;

type PreparedPrompt = Readonly<{
  args: string[];
  stdin: string | undefined;
  cleanup: () => Promise<void>;
}>;

type ProcessClose = Readonly<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}>;

type LineAccumulator = Readonly<{
  push: (chunk: string) => void;
  finish: () => void;
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
    return finishFailureSafely(
      recorder,
      context.callContext,
      [],
      'failed',
      'callback-failure',
      'Runner adapter setup failed',
    );
  }
  let callbackFailed = false;
  let recorder: RunnerCallRecorder;
  try {
    recorder = createRunnerCallRecorder({
      context: context.callContext,
      credentialValues,
      onEvent: (event) => {
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
    return fail(recorder, 'failed', 'callback-failure', 'Runner event callback failed');
  }

  let invocationArgs: string[];
  try {
    invocationArgs = [...context.invocation.args];
  } catch {
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      'argument-conflict',
      'CLI invocation arguments could not be read',
    );
  }

  let validation: unknown;
  try {
    validation = adapter.validateArgs(invocationArgs);
  } catch {
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      'callback-failure',
      'CLI argument validation failed',
    );
  }

  const normalizedValidation = normalizeCliArgumentValidation(validation);
  if (normalizedValidation === null) {
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      'callback-failure',
      'CLI argument validation returned an invalid result',
    );
  }

  if (!normalizedValidation.valid) {
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      'argument-conflict',
      `CLI arguments conflict with the adapter contract: ${formatArgumentConflicts(normalizedValidation.conflicts)}`,
    );
  }

  let prepared: PreparedPrompt;
  try {
    prepared = await preparePrompt(adapter, context.invocation, invocationArgs, context.prompt);
  } catch (cause) {
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      prelaunchErrorCode(cause),
      prelaunchErrorMessage(cause),
    );
  }

  const protocolEvents: CliProtocolEvent[] = [];
  let stdout = '';
  let stderr = '';
  let eventCount = 0;
  let terminalSeen = false;
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new DOMException('CLI invocation timed out', 'TimeoutError')),
    context.invocation.timeoutMs,
  );
  timeout.unref?.();
  const signal = context.invocation.signal
    ? AbortSignal.any([context.invocation.signal, timeoutController.signal])
    : timeoutController.signal;

  const applyProtocolEvent = (event: CliProtocolEvent): void => {
    if (terminalSeen) {
      throw fatal('protocol-failure', 'CLI emitted output after its terminal result');
    }
    eventCount += 1;
    if (eventCount > RUNNER_CALL_OUTPUT_MAX_EVENTS) {
      throw fatal('output-budget-breach', 'CLI protocol event budget was exceeded');
    }
    protocolEvents.push(event);
    switch (event.type) {
      case 'text':
        if (event.channel === 'stderr') recorder.stderr({ text: event.text });
        else recorder.text({ channel: event.channel, text: event.text });
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
        if (terminalSeen) throw fatal('protocol-failure', 'CLI emitted multiple terminal results');
        terminalSeen = true;
        return;
      default: {
        const _exhaustive: never = event;
        throw _exhaustive;
      }
    }
  };

  const lineAccumulator = createLineAccumulator((line) => {
    let parsed: readonly CliProtocolEvent[];
    try {
      parsed = adapter.parse(line);
    } catch {
      throw fatal('protocol-failure', 'CLI output did not match its structured protocol');
    }
    for (const event of parsed) applyProtocolEvent(event);
  });

  try {
    const executableState = await revalidateCliExecutableIdentity(context.invocation.executable);
    if (executableState !== 'match') {
      return executableState === 'missing'
        ? fail(recorder, 'failed', 'spawn-not-found', 'Configured CLI executable was not found')
        : fail(
            recorder,
            'failed',
            'cli-executable-identity-drift',
            'CLI executable identity changed; run readiness checks again before execution',
          );
    }
    const closed = await spawnPipe<ProcessClose>({
      command: context.invocation.executable.path,
      args: prepared.args,
      cwd: context.invocation.cwd,
      env: { ...context.invocation.environment },
      detached: process.platform !== 'win32',
      stdin: prepared.stdin,
      signal,
      outputBudgetBytes: RUNNER_CALL_OUTPUT_MAX_BYTES + 1,
      partialStdoutMaxBytes: RUNNER_CALL_OUTPUT_MAX_BYTES,
      partialStderrMaxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
      ...(context.onSpawned !== undefined && { onSpawned: context.onSpawned }),
      onStdout(chunk) {
        stdout += chunk;
        try {
          lineAccumulator.push(chunk);
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
        lineAccumulator.finish();
        return { exitCode, signal: processSignal, stdout, stderr };
      },
    });

    if (closed.signal !== null) {
      return fail(recorder, 'failed', 'signal-exit', `CLI exited from signal ${closed.signal}`);
    }
    if (adapter.outputContract.kind === 'text-exit') {
      if (!adapter.outputContract.successfulExitCodes.includes(closed.exitCode ?? -1)) {
        return fail(
          recorder,
          'failed',
          'non-zero-exit',
          `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
        );
      }
    } else if (closed.exitCode !== 0) {
      return fail(
        recorder,
        'failed',
        'non-zero-exit',
        `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
      );
    }

    if (adapter.outputContract.kind === 'structured-terminal' && !terminalSeen) {
      return fail(
        recorder,
        'incomplete',
        'protocol-failure',
        'CLI ended without its required terminal result',
      );
    }

    let terminal: Extract<CliProtocolEvent, { type: 'result' }>;
    try {
      terminal = adapter.terminal({
        outputContract: adapter.outputContract,
        events: protocolEvents,
        stdout: closed.stdout,
        stderr: closed.stderr,
        exitCode: closed.exitCode,
        signal: closed.signal,
      });
    } catch {
      return fail(recorder, 'failed', 'protocol-failure', 'CLI terminal result was invalid');
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
    if (signal.aborted) {
      const status = runnerCallInterruptedStatus(signal);
      return finishFailureSafely(
        recorder,
        context.callContext,
        credentialValues,
        status,
        status === 'timeout' ? 'timeout' : 'user-abort',
        status === 'timeout' ? 'CLI invocation timed out' : 'CLI invocation was aborted',
      );
    }
    if (spawnPipeError.isStdinIncomplete(cause)) {
      return finishFailureSafely(
        recorder,
        context.callContext,
        credentialValues,
        'failed',
        'prompt-transport-error',
        'CLI prompt could not be fully delivered through stdin',
      );
    }
    const fatalState = fatalStateOf(cause);
    if (fatalState !== null) {
      return finishFailureSafely(
        recorder,
        context.callContext,
        credentialValues,
        fatalState === 'output-budget-breach' ? 'truncated' : 'failed',
        fatalState,
        errorMessage(cause),
      );
    }
    if (isENOENT(cause)) {
      return finishFailureSafely(
        recorder,
        context.callContext,
        credentialValues,
        'failed',
        'spawn-not-found',
        'Configured CLI executable was not found',
      );
    }
    return finishFailureSafely(
      recorder,
      context.callContext,
      credentialValues,
      'failed',
      'protocol-failure',
      runnerCallErrorFromUnknown(cause, 'protocol-failure', credentialValues).message,
    );
  } finally {
    clearTimeout(timeout);
    await prepared.cleanup();
  }
}

export async function revalidateCliExecutableIdentity(
  identity: CliExecutableIdentity,
): Promise<'match' | 'missing' | 'drift'> {
  try {
    const path = await realpath(identity.path);
    const info = await stat(path);
    if (!info.isFile()) return 'drift';
    if (
      path !== identity.path ||
      info.dev !== identity.fingerprint.dev ||
      info.ino !== identity.fingerprint.ino ||
      info.size !== identity.fingerprint.size ||
      info.mtimeMs !== identity.fingerprint.mtimeMs
    ) {
      return 'drift';
    }
    return 'match';
  } catch (cause) {
    return isENOENT(cause) ? 'missing' : 'drift';
  }
}

function callbackFailure(
  context: RunnerCallContext,
  credentialValues: readonly string[],
): RunnerCallResult {
  return fail(
    createRunnerCallRecorder({ context, credentialValues }),
    'failed',
    'callback-failure',
    'Runner event callback failed',
  );
}

function finishFailureSafely(
  recorder: RunnerCallRecorder,
  context: RunnerCallContext,
  credentialValues: readonly string[],
  status: RunnerCallFailureStatus,
  code: string,
  message: string,
): RunnerCallResult {
  try {
    return fail(recorder, status, code, message);
  } catch {
    // Consumer callbacks are untrusted code. If one throws while the terminal failure is being
    // emitted, finish through a recorder without that callback rather than leaking a raw throw.
    return fail(createRunnerCallRecorder({ context, credentialValues }), status, code, message);
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
    if (declaredNames.has(name) || looksLikeCredentialEnvironmentName(name)) values.push(value);
  }
  values.push(...sandboxCredentialValues(environment));
  return [...new Set(values)];
}

function looksLikeCredentialEnvironmentName(name: string): boolean {
  return /(?:^|[_.-])(?:API[_.-]?KEY|KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH(?:ORIZATION)?)(?:$|[_.-])/i.test(
    name,
  );
}

async function preparePrompt(
  adapter: CliAdapter,
  invocation: CliInvocation,
  invocationArgs: readonly string[],
  prompt: string,
): Promise<PreparedPrompt> {
  const transport = adapter.promptTransport;
  if (transport.kind !== invocation.promptTransport.kind) {
    throw error(
      'prompt-transport-error',
      'Invocation prompt transport does not match the adapter contract',
    );
  }
  if (transport.kind === 'stdin') {
    rejectPlaceholder(invocationArgs);
    return { args: [...invocationArgs], stdin: prompt, cleanup: async () => {} };
  }
  if (transport.kind === 'argv') {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > transport.maxBytes) {
      throw transportError(
        `CLI prompt is ${bytes} bytes and exceeds the ${transport.maxBytes}-byte argv limit`,
      );
    }
    return {
      args: replacePromptArgument(invocationArgs, prompt),
      stdin: undefined,
      cleanup: async () => {},
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-prompt-'));
  const path = join(directory, PROMPT_FILE_NAME);
  try {
    await writeFile(path, prompt, { encoding: 'utf8', flag: 'wx', mode: transport.mode });
    await chmod(path, transport.mode);
    return {
      args: replacePromptArgument(invocationArgs, path),
      stdin: undefined,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

function replacePromptArgument(args: readonly string[], replacement: string): string[] {
  const matches = args.filter((arg) => arg === PROMPT_PLACEHOLDER).length;
  if (matches !== 1) {
    throw transportError('Prompt transport requires exactly one standalone <PROMPT> argument');
  }
  return args.map((arg) => (arg === PROMPT_PLACEHOLDER ? replacement : arg));
}

function rejectPlaceholder(args: readonly string[]): void {
  if (args.some((arg) => arg.includes(PROMPT_PLACEHOLDER))) {
    throw transportError('stdin prompt transport cannot include a prompt placeholder in argv');
  }
}

function createLineAccumulator(onLine: (line: string) => void): LineAccumulator {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const framed = pending.slice(0, newline);
        const line = framed.endsWith('\r') ? framed.slice(0, -1) : framed;
        enforceLineLimit(line);
        onLine(line);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      enforceLineLimit(pending);
    },
    finish() {
      if (pending.length === 0) return;
      const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      enforceLineLimit(line);
      pending = '';
      onLine(line);
    },
  };
}

function enforceLineLimit(line: string): void {
  if (Buffer.byteLength(line, 'utf8') > DEFAULT_PROCESS_LINE_MAX_BYTES) {
    throw fatal('output-budget-breach', 'CLI output line exceeded the line byte budget');
  }
}

function fail(
  recorder: RunnerCallRecorder,
  status: RunnerCallFailureStatus,
  code: string,
  message: string,
): RunnerCallResult {
  return recorder.finishFailed({
    status,
    error: { code, message },
  });
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

function transportError(message: string): Error {
  return error('prompt-transport-error', message);
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
