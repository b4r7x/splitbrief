import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import {
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner-fields.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import { createSanitizedChildEnv } from '../../../lib/process/spawn/child-env.js';
import { processError } from '../../../lib/process/errors.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable, sanitizedRuntimePath } from '../resolve-cli-executable.js';
import { CLI_PROMPT_SENTINEL } from '../cli-tools/candidate-contract.js';
import { claudeCodePlannerAdapter } from '../cli-tools/claude-code.js';
import { sandboxCredentialValues } from '../sandbox-env.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import {
  finishRunnerCallOutputLimit,
  runnerCallLineOutputLimit,
  type RunnerCallOutputLimit,
} from '../../calls/output-limit.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import { error } from '../../../utils/error.js';
import {
  buildClaudeIdleOptions,
  createStreamHandler,
  finishClaudeOutputLimit,
  finishClaudeStream,
  interruptedError,
  markFailedClaudeStream,
  markInterruptedClaudeStream,
  throwForClaudeCallFailure,
} from './stream.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../cli-tools/process-invoke.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

let claudeCallSequence = 0;

function createClaudeCallContext(opts: {
  role: RunnerCallContext['role'];
  model?: string | undefined;
}): RunnerCallContext {
  return {
    callId: `claude-${++claudeCallSequence}`,
    role: opts.role,
    backendKind: 'cli',
    runnerName: 'claude',
    ...(opts.model !== undefined && { model: opts.model }),
  };
}

const ENVELOPE_LIMIT_WARNING_CODES: ReadonlySet<string> = new Set([
  'task_compiler_output_limited',
  'task_compiler_timeout',
]);

type ClaudeEnvelopeGuard = Readonly<{
  signal: AbortSignal | undefined;
  idleWarnMs: number;
  idleKillMs: number;
  outputBudgetBytes: number | undefined;
  outputMaxBytes: number | undefined;
  onEvent: (event: RunnerCallEvent) => void;
  limit: () => RunnerCallOutputLimit | null;
  cleanup: () => void;
}>;

/**
 * The canonical call envelope is the hard ceiling at the Claude spawn
 * boundary: its deadline drives the cancellation timer, its idle bound clamps
 * the watchdog kill, and its raw bound clamps the spawn byte budget. A breach
 * the recorder latches surfaces as a canonical limit warning; aborting here
 * reaps the tree so the terminal stays truncated instead of only recorded.
 */
function createClaudeEnvelopeGuard(opts: {
  envelope: TaskCompilationCallEnvelope | undefined;
  signal: AbortSignal | undefined;
  idleWarnMs: number | undefined;
  idleKillMs: number | undefined;
}): ClaudeEnvelopeGuard {
  if (opts.envelope === undefined) {
    return {
      signal: opts.signal,
      idleWarnMs: opts.idleWarnMs ?? RUNNER_IDLE_WARN_MS,
      idleKillMs: opts.idleKillMs ?? RUNNER_IDLE_KILL_MS,
      outputBudgetBytes: undefined,
      outputMaxBytes: undefined,
      onEvent: () => undefined,
      limit: () => null,
      cleanup: () => undefined,
    };
  }
  const controller = new AbortController();
  let envelopeLimit: RunnerCallOutputLimit | null = null;
  const deadlineTimer = setTimeout(() => {
    controller.abort(
      new DOMException('Claude call exceeded its envelope deadline', 'TimeoutError'),
    );
  }, opts.envelope.deadlineMs);
  deadlineTimer.unref?.();
  return {
    signal:
      opts.signal === undefined
        ? controller.signal
        : AbortSignal.any([opts.signal, controller.signal]),
    idleWarnMs: Math.min(opts.idleWarnMs ?? RUNNER_IDLE_WARN_MS, opts.envelope.idleTimeoutMs),
    idleKillMs: Math.min(opts.idleKillMs ?? RUNNER_IDLE_KILL_MS, opts.envelope.idleTimeoutMs),
    outputBudgetBytes: Math.min(CLI_RAW_OUTPUT_MAX_BYTES, opts.envelope.maxRawProtocolBytes),
    outputMaxBytes: Math.min(CLI_RAW_OUTPUT_MAX_BYTES, opts.envelope.maxRawProtocolBytes),
    onEvent(event) {
      if (envelopeLimit !== null) return;
      if (event.type !== 'call_warning') return;
      if (!ENVELOPE_LIMIT_WARNING_CODES.has(event.warning.code)) return;
      envelopeLimit = { code: event.warning.code, message: event.warning.message };
      controller.abort(new DOMException(event.warning.message, 'TimeoutError'));
    },
    limit: () => envelopeLimit,
    cleanup: () => clearTimeout(deadlineTimer),
  };
}

interface ClaudeEnvelopeCallOptions {
  ledger?: TaskDispatchLedger | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
}

function prepareClaudeEnvelopeCall(opts: {
  callContext: RunnerCallContext | undefined;
  role: RunnerCallContext['role'];
  model: string | undefined;
  signal: AbortSignal | undefined;
  idleWarnMs: number | undefined;
  idleKillMs: number | undefined;
  ledger: TaskDispatchLedger | undefined;
  attemptId: TaskCompilationAttemptId | undefined;
  envelope: TaskCompilationCallEnvelope | undefined;
}): {
  context: RunnerCallContext;
  attemptId: TaskCompilationAttemptId | undefined;
  guard: ClaudeEnvelopeGuard;
} {
  const baseContext =
    opts.callContext ?? createClaudeCallContext({ role: opts.role, model: opts.model });
  const envelope = opts.envelope ?? baseContext.envelope;
  const compiled =
    opts.ledger !== undefined || opts.attemptId !== undefined || opts.envelope !== undefined;
  const attemptId = compiled
    ? (opts.attemptId ?? baseContext.attemptId ?? createTaskCompilationAttemptId())
    : undefined;
  return {
    context: {
      ...baseContext,
      ...(attemptId !== undefined && { attemptId }),
      ...(envelope !== undefined && { envelope }),
    },
    attemptId,
    guard: createClaudeEnvelopeGuard({
      envelope,
      signal: opts.signal,
      idleWarnMs: opts.idleWarnMs,
      idleKillMs: opts.idleKillMs,
    }),
  };
}

function claimClaudeDispatch(
  state: ReturnType<typeof createStreamHandler>['state'],
  ledger: TaskDispatchLedger,
  attemptId: TaskCompilationAttemptId | undefined,
): void {
  if (attemptId === undefined) {
    throw error('task_compiler_dispatch_limit', 'Claude dispatch has no attempt identity');
  }
  const claim = ledger.claimDispatch(attemptId);
  if (claim.kind === 'refused') {
    const message = `operation dispatch limit reached (${claim.dispatchCount}/${claim.dispatchLimit})`;
    state.recorder.finishFailed({
      status: 'refused',
      error: { code: 'task_compiler_dispatch_limit', message },
      partial: false,
    });
    throw error('task_compiler_dispatch_limit', message, {
      dispatchCount: claim.dispatchCount,
      dispatchLimit: claim.dispatchLimit,
    });
  }
}

interface BuildArgsOpts {
  projectDir: string;
  mode: 'plan' | 'escalate';
  sessionId?: string | null;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
}

async function defaultClaudeEnv(
  projectDir: string,
  authChannel: CliAuthChannelId | undefined,
): Promise<NodeJS.ProcessEnv> {
  const preserveKeys = authChannel === 'api-key' ? ['ANTHROPIC_API_KEY'] : [];
  const env = createSanitizedChildEnv(process.env, preserveKeys);
  env.PATH = await sanitizedRuntimePath(projectDir);
  return env;
}

function claudeCredentialValues(
  authChannel: CliAuthChannelId | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const apiKey = authChannel === 'api-key' ? env.ANTHROPIC_API_KEY : undefined;
  return [...(apiKey === undefined ? [] : [apiKey]), ...sandboxCredentialValues(env)];
}

function redactClaudeExecutablePath(value: string, executablePath: string): string {
  if (executablePath.length === 0 || !value.includes(executablePath)) return value;
  return value.split(executablePath).join('claude');
}

function normalizeClaudeProcessOutputError(
  err: unknown,
  executablePath: string | undefined,
  redactCredential?: (value: string) => string,
): unknown {
  if (!processError.isExitCode(err)) return err;

  const knownPaths = [err.data.command, executablePath].filter(
    (path, index, paths): path is string =>
      typeof path === 'string' && path.length > 0 && paths.indexOf(path) === index,
  );
  const redact = (value: string): string =>
    redactCredential?.(
      knownPaths.reduce((current, path) => redactClaudeExecutablePath(current, path), value),
    ) ?? value;
  const stderr = redact(err.data.stderr);
  const output = redact(err.data.output);
  const detailPrefix = ` exited with code ${err.data.code}`;
  const detailStart = err.message.indexOf(detailPrefix);
  const originalDetail =
    detailStart < 0
      ? undefined
      : err.message.slice(detailStart + detailPrefix.length).replace(/^: /, '');

  return processError.exitCode({
    command: 'claude',
    ...(err.data.label !== undefined && { label: redact(err.data.label) }),
    code: err.data.code,
    stderr,
    output,
    ...(originalDetail !== undefined && { detail: redact(originalDetail) }),
  });
}

async function resolveTrustedClaudeExecutable(
  projectDir: string,
  executable: CliExecutableIdentity | null | undefined,
): Promise<CliExecutableIdentity> {
  if (executable === null || executable === undefined) {
    throw error(
      'cli-executable-untrusted',
      'Claude Code CLI has no trusted readiness identity; run readiness checks again before execution.',
      { tool: 'claude-code' },
    );
  }
  return resolveCliExecutable({ command: 'claude', projectDir, trust: executable });
}

function applyImageRefs(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

/**
 * The claude-code adapter owns this argv, so the run, the readiness arg-vector
 * preflight and the protected-flag guard all read one vector: configured
 * `planner.args` ride behind the adapter's base args, and the adapter's own
 * validation rejects a configured flag that fights that base.
 */
export function buildClaudeArgs(opts: BuildArgsOpts): string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  const baseArgs = [
    ...claudeCodePlannerAdapter.baseArgs({
      prompt: CLI_PROMPT_SENTINEL,
      model: opts.model,
      projectDir: opts.projectDir,
      configuredArgs,
      mode: opts.mode,
      sessionId: opts.sessionId ?? null,
      effort: opts.effort,
    }),
  ];
  const args = [...baseArgs, ...configuredArgs];
  const validation = claudeCodePlannerAdapter.validateArgs({
    invocationArgs: args,
    baseArgs: baseArgs,
  });
  if (!validation.valid) {
    throw error(
      'cli-argument-conflict',
      `Configured Claude Code arguments conflict with the invocation SPLITBRIEF owns: ${validation.conflicts.join(', ')}`,
      { tool: 'claude-code', conflicts: validation.conflicts },
    );
  }
  return args;
}

interface ClaudeCallRunOptions extends ClaudeEnvelopeCallOptions {
  args: string[];
  stdin: string;
  projectDir: string;
  spawnEnv: NodeJS.ProcessEnv;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

async function runClaudeCall(
  opts: ClaudeCallRunOptions,
): Promise<{ result: RunnerCallResult; sessionId: string | null }> {
  const { context, attemptId, guard } = prepareClaudeEnvelopeCall({
    callContext: opts.callContext,
    model: opts.model,
    role: 'planner',
    signal: opts.signal,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });
  const { state, handleLine } = createStreamHandler({
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onQuestion: opts.onQuestion,
    onCallEvent: (event) => {
      guard.onEvent(event);
      opts.onCallEvent?.(event);
    },
    credentialValues: claudeCredentialValues(opts.authChannel, opts.spawnEnv),
    context,
  });
  state.sessionId = opts.sessionId;

  let trustedExecutablePath: string | undefined;
  try {
    trustedExecutablePath = (await resolveTrustedClaudeExecutable(opts.projectDir, opts.executable))
      .path;
    if (opts.ledger !== undefined) {
      claimClaudeDispatch(state, opts.ledger, attemptId);
    }
    await spawnWithStdin({
      command: trustedExecutablePath,
      args: opts.args,
      cwd: opts.projectDir,
      env: opts.spawnEnv,
      stdin: opts.stdin,
      notFoundMessage: CLAUDE_NOT_FOUND,
      onLine: handleLine,
      onStdoutLineOverflow: (overflow) => {
        finishClaudeOutputLimit(
          state,
          runnerCallLineOutputLimit({
            code: 'stdout_line_overflow',
            label: 'stdout line',
            lineBytes: overflow.lineBytes,
            maxLineBytes: overflow.maxLineBytes,
          }),
        );
      },
      errorDetail: () => state.resultText ?? undefined,
      signal: guard.signal,
      idle: buildClaudeIdleOptions(state, {
        idleWarnMs: guard.idleWarnMs,
        idleKillMs: guard.idleKillMs,
      }),
      outputBudgetBytes: guard.outputBudgetBytes,
      outputMaxBytes: guard.outputMaxBytes,
    });
  } catch (err) {
    const safeError = normalizeClaudeProcessOutputError(
      err,
      trustedExecutablePath ?? opts.executable?.path,
      state.redactCredential,
    );
    const limit = guard.limit();
    if (limit !== null) {
      finishRunnerCallOutputLimit(state.recorder, limit, {
        usage: state.usage,
        nativeSessionId: state.sessionId,
      });
      throwForClaudeCallFailure(state.recorder.finalResult());
    }
    markInterruptedClaudeStream(state, guard.signal);
    if (!guard.signal?.aborted) markFailedClaudeStream(state, safeError);
    throw interruptedError(opts.signal, safeError, state.redactCredential);
  } finally {
    guard.cleanup();
  }

  const result = finishClaudeStream(state);

  return { result: { ...result, text: state.text }, sessionId: state.sessionId };
}

type ClaudePlannerStreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ClaudePlannerStreamOpts extends ClaudeEnvelopeCallOptions {
  prompt: string;
  projectDir: string;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudePlannerStream(
  opts: ClaudePlannerStreamOpts,
): Promise<ClaudePlannerStreamResult> {
  const args = buildClaudeArgs({
    projectDir: opts.projectDir,
    mode: 'plan',
    sessionId: opts.sessionId,
    model: opts.model,
    effort: opts.effort,
    configuredArgs: opts.configuredArgs,
  });
  const spawnEnv = opts.env ?? (await defaultClaudeEnv(opts.projectDir, opts.authChannel));

  const { result, sessionId } = await runClaudeCall({
    args,
    stdin: applyImageRefs(opts.prompt, opts.images),
    projectDir: opts.projectDir,
    spawnEnv,
    sessionId: opts.sessionId,
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onQuestion: opts.onQuestion,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });

  return { ...result, sessionId };
}

export interface ClaudeOneShotOpts extends ClaudeEnvelopeCallOptions {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<RunnerCallResult> {
  const args = buildClaudeArgs({
    projectDir: opts.projectDir,
    mode: 'escalate',
    model: opts.model,
    effort: opts.effort,
    configuredArgs: opts.configuredArgs,
  });
  const spawnEnv = opts.env ?? (await defaultClaudeEnv(opts.projectDir, opts.authChannel));

  const { result } = await runClaudeCall({
    args,
    stdin: opts.prompt,
    projectDir: opts.projectDir,
    spawnEnv,
    sessionId: null,
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });

  return result;
}
