import {
  createHeadTailEventLog,
  RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
  createRunnerCallDeltaLimiter,
  RUNNER_CALL_STDERR_MAX_BYTES,
} from '../output-limit.js';
import { createRunnerCallCredentialRedactor } from '../status.js';
import type { RunnerCallContext, RunnerCallEvent } from '../types.js';
import { recordStderr, recordText, recordToolUseDelta, recordToolUseDone } from './deltas.js';
import { emit, snapshot } from './emit.js';
import { snapshotRunnerCallContext, streamedTextBytes, createTextLimiter } from './fields.js';
import { finalResult, finishCompleted, finishFailed } from './finish.js';
import {
  recordHeartbeat,
  recordRuntimeStatus,
  recordSessionId,
  recordStallCleared,
  recordStalled,
  recordUnknownUpstream,
  recordWarning,
} from './records.js';
import type { RunnerCallRecorder, RunnerCallRecorderState } from './types.js';

export function createRunnerCallRecorder(opts: {
  context: RunnerCallContext;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  /** The seat's opt-in `maxToolCalls`: the tool use after it stops the call through `onLimit`. */
  stopAfterToolUses?: number | undefined;
  onLimit?: (() => void) | undefined;
  startedAt?: number | undefined;
  credentialValues?: readonly string[] | undefined;
}): RunnerCallRecorder {
  const state: RunnerCallRecorderState = {
    context: snapshotRunnerCallContext(opts.context),
    startedAt: opts.startedAt ?? Date.now(),
    onEvent: opts.onEvent,
    stopAfterToolUses: opts.stopAfterToolUses,
    onLimit: opts.onLimit,
    credentialValues: opts.credentialValues,
    redactCredential: createRunnerCallCredentialRedactor(opts.credentialValues ?? []),
    events: createHeadTailEventLog(RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES, streamedTextBytes),
    hasTerminalEvent: false,
    toolUseDoneCount: 0,
    warningCount: 0,
    unknownUpstreamCount: 0,
    stderrPreview: '',
    stderrWarningEmitted: false,
    lastNativeSessionId: null,
    lastResolvedModel: undefined,
    lastHeartbeatTs: null,
    activeToolUse: null,
    recentToolUses: [],
    toolUseStop: null,
    emittedLimitWarnings: new Set<string>(),
    textLimiter: createTextLimiter(),
    subagentTextLimiter: createTextLimiter(),
    stderrLimiter: createRunnerCallDeltaLimiter({
      code: 'runner_call_stderr_limit',
      label: 'The tool error output',
      maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
    }),
    toolDeltaLimiter: createRunnerCallDeltaLimiter({
      code: 'runner_call_tool_delta_limit',
      label: 'The streamed tool input',
    }),
  };

  emit(state, { type: 'call_started', ts: state.startedAt, ...state.context });

  return {
    context: state.context,
    startedAt: state.startedAt,
    hasTerminal: () => state.hasTerminalEvent,
    text: (eventOpts) => recordText(state, eventOpts),
    stderr: (eventOpts) => recordStderr(state, eventOpts),
    toolUseDelta: (eventOpts) => recordToolUseDelta(state, eventOpts),
    toolUseDone: (eventOpts) => recordToolUseDone(state, eventOpts),
    sessionId: (eventOpts) => recordSessionId(state, eventOpts),
    warning: (eventOpts) => recordWarning(state, eventOpts),
    unknownUpstream: (eventOpts) => recordUnknownUpstream(state, eventOpts),
    runtimeStatus: (runtimeStatus) => recordRuntimeStatus(state, runtimeStatus),
    stalled: (eventOpts) => recordStalled(state, eventOpts),
    stallCleared: (eventOpts) => recordStallCleared(state, eventOpts),
    heartbeat: (eventOpts) => recordHeartbeat(state, eventOpts),
    finishCompleted: (finishOpts) => finishCompleted(state, finishOpts),
    finishFailed: (finishOpts) => finishFailed(state, finishOpts),
    finalResult: () => finalResult(state),
    snapshot: () => snapshot(state),
  };
}
