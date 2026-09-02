import {
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner-fields.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import type { RunnerCallOutputLimit } from '../../calls/output-limit.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import { error } from '../../../utils/error.js';
import type { createStreamHandler } from './stream.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../cli-tools/process-invoke.js';

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

export type ClaudeEnvelopeGuard = Readonly<{
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
export function createClaudeEnvelopeGuard(opts: {
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

export interface ClaudeEnvelopeCallOptions {
  ledger?: TaskDispatchLedger | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
}

export function prepareClaudeEnvelopeCall(opts: {
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

export function claimClaudeDispatch(
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
