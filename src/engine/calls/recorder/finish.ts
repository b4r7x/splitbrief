import { boundRunnerCallStructured } from '../bounded-payload.js';
import { runnerCallLimitError } from '../output-limit.js';
import {
  boundedRunnerCallMessage,
  runnerCallCompletedEvent,
  runnerCallErrorEvent,
} from '../status.js';
import type { RunnerCallResult, RunnerCallUsage } from '../types.js';
import { emitStderrDiagnosticWarning } from './deltas.js';
import { emit, noteLimit, snapshot } from './emit.js';
import { boundedRunnerCallProviderType, hasPartialResult, runnerCallRawTail } from './fields.js';
import type { RunnerCallRecorder, RunnerCallRecorderState } from './types.js';

function currentTerminalDefaults(
  state: RunnerCallRecorderState,
  opts: {
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
  },
): {
  usage: RunnerCallUsage | null;
  nativeSessionId: string | null;
  partial: boolean;
} {
  const current = snapshot(state);
  return {
    usage: opts.usage === undefined ? current.usage : opts.usage,
    nativeSessionId:
      opts.nativeSessionId === undefined ? current.nativeSessionId : opts.nativeSessionId,
    partial: hasPartialResult(current),
  };
}

export function finishCompleted(
  state: RunnerCallRecorderState,
  finishOpts: Parameters<RunnerCallRecorder['finishCompleted']>[0] = {},
): RunnerCallResult {
  if (state.hasTerminalEvent) return snapshot(state);
  const defaults = currentTerminalDefaults(state, finishOpts);
  if (state.toolUseStop !== null) {
    return finishFailed(state, {
      status: 'truncated',
      error: runnerCallLimitError(state.toolUseStop),
      usage: defaults.usage,
      nativeSessionId: defaults.nativeSessionId,
      partial: true,
      endedAt: finishOpts.endedAt,
    });
  }
  noteCutText(state);
  const terminal = {
    startedAt: state.startedAt,
    endedAt: finishOpts.endedAt ?? Date.now(),
    usage: defaults.usage,
    nativeSessionId: defaults.nativeSessionId,
    ...(finishOpts.structured !== undefined && { structured: finishOpts.structured }),
  };
  const completed = runnerCallCompletedEvent(state.context, terminal);
  const structured =
    finishOpts.structured === undefined ? null : boundRunnerCallStructured(finishOpts.structured);
  if (structured !== null && structured.limit !== null) {
    noteLimit(state, structured.limit);
    emit(
      state,
      completed,
      true,
      runnerCallCompletedEvent(state.context, { ...terminal, structured: structured.value }),
    );
  } else {
    emit(state, completed);
  }
  return snapshot(state);
}

export function finishFailed(
  state: RunnerCallRecorderState,
  finishOpts: Parameters<RunnerCallRecorder['finishFailed']>[0],
): RunnerCallResult {
  if (state.hasTerminalEvent) return snapshot(state);
  const defaults = currentTerminalDefaults(state, finishOpts);
  const providerType =
    finishOpts.error.providerType === undefined
      ? undefined
      : boundedRunnerCallProviderType(state.redactCredential(finishOpts.error.providerType));
  const callError =
    state.toolUseStop === null
      ? {
          code: state.redactCredential(finishOpts.error.code),
          message: boundedRunnerCallMessage(finishOpts.error.message, state.credentialValues),
          ...(finishOpts.error.status !== undefined && { status: finishOpts.error.status }),
          ...(providerType !== undefined && { providerType }),
        }
      : {
          code: state.toolUseStop.code,
          message: boundedRunnerCallMessage(
            runnerCallLimitError(state.toolUseStop).message,
            state.credentialValues,
          ),
        };
  const rawTail = runnerCallRawTail(callError.message, state.credentialValues);
  if (state.toolUseStop === null) noteCutText(state);
  emitStderrFailureWarning(state);
  emit(
    state,
    runnerCallErrorEvent(state.context, {
      startedAt: state.startedAt,
      endedAt: finishOpts.endedAt ?? Date.now(),
      status: state.toolUseStop === null ? finishOpts.status : 'truncated',
      error: callError,
      usage: defaults.usage,
      nativeSessionId: defaults.nativeSessionId,
      partial: state.toolUseStop === null ? (finishOpts.partial ?? defaults.partial) : true,
      ...(rawTail !== undefined && { rawTail }),
    }),
  );
  return snapshot(state);
}

export function finalResult(state: RunnerCallRecorderState): RunnerCallResult {
  return finishFailed(state, {
    status: 'incomplete',
    error: {
      code: 'missing_terminal_event',
      message: 'Runner call ended without a terminal event',
    },
  });
}

// Judged on the text the call ends with: a final text that fits replaced
// whatever the budget cut from the narration streamed before it.
function noteCutText(state: RunnerCallRecorderState): void {
  if (state.textLimiter.limit !== null) noteLimit(state, state.textLimiter.limit);
}

function emitStderrFailureWarning(state: RunnerCallRecorderState): void {
  if (state.stderrPreview.trim().length === 0) return;
  emitStderrDiagnosticWarning(state, 'stderr_on_failure', state.stderrPreview);
}
