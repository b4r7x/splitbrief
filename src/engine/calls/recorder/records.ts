import { sanitizeRunnerCallRawPreview } from '../bounded-payload.js';
import {
  runnerCallItemLimit,
  RUNNER_CALL_WARNING_MAX_ITEMS,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
} from '../output-limit.js';
import { redactRunnerCallWarningInput } from '../redact-event.js';
import { normalizeRunnerCallWarning } from '../warnings.js';
import { emit, noteLimit } from './emit.js';
import type { RunnerCallRecorder, RunnerCallRecorderState } from './types.js';

const RUNNER_CALL_HEARTBEAT_INTERVAL_MS = 1_000;

export function recordUsage(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['usage']>[0],
): void {
  emit(state, {
    type: 'call_usage',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    usage: eventOpts.usage,
    semantics: eventOpts.semantics,
  });
}

export function recordSessionId(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['sessionId']>[0],
): void {
  // A native session id has cardinality one per call, but stream protocols
  // stamp it on every frame: without this guard one call restates the same
  // id hundreds of times and every consumer treats each as news. Only some
  // frames name the model, so a frame without one keeps the model recorded.
  const newModel =
    eventOpts.resolvedModel !== undefined && eventOpts.resolvedModel !== state.lastResolvedModel;
  if (eventOpts.nativeSessionId === state.lastNativeSessionId && !newModel) return;
  state.lastNativeSessionId = eventOpts.nativeSessionId;
  state.lastResolvedModel = eventOpts.resolvedModel;
  emit(state, {
    type: 'call_session_id',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    nativeSessionId: eventOpts.nativeSessionId,
    ...(eventOpts.resolvedModel !== undefined && { resolvedModel: eventOpts.resolvedModel }),
  });
}

export function recordWarning(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['warning']>[0],
): void {
  if (state.warningCount >= RUNNER_CALL_WARNING_MAX_ITEMS) {
    noteLimit(
      state,
      runnerCallItemLimit({
        code: 'runner_call_warning_count_limit',
        label: 'warnings',
        maxItems: RUNNER_CALL_WARNING_MAX_ITEMS,
      }),
    );
    return;
  }
  const warning = normalizeRunnerCallWarning(
    redactRunnerCallWarningInput(eventOpts.warning, state.redactCredential),
  );
  state.warningCount += 1;
  if (warning.source === 'stderr') state.stderrWarningEmitted = true;
  emit(state, {
    type: 'call_warning',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    warning,
  });
}

export function recordUnknownUpstream(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['unknownUpstream']>[0],
): void {
  if (state.unknownUpstreamCount >= RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS) {
    noteLimit(
      state,
      runnerCallItemLimit({
        code: 'runner_call_unknown_upstream_count_limit',
        label: 'unknown tool records',
        maxItems: RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
      }),
    );
    return;
  }
  state.unknownUpstreamCount += 1;
  const rawPreview = sanitizeRunnerCallRawPreview(state.redactCredential(eventOpts.rawPreview));
  emit(state, {
    type: 'call_unknown_upstream',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    rawPreview,
    backendMetadata: eventOpts.backendMetadata,
  });
}

export function recordRuntimeStatus(
  state: RunnerCallRecorderState,
  runtimeStatus: Parameters<RunnerCallRecorder['runtimeStatus']>[0],
): void {
  emit(state, { type: 'call_runtime_status', ts: Date.now(), ...state.context, runtimeStatus });
}

export function recordStalled(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['stalled']>[0],
): void {
  emit(state, {
    type: 'call_stalled',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    silentMs: eventOpts.silentMs,
  });
}

export function recordStallCleared(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['stallCleared']>[0],
): void {
  emit(state, {
    type: 'call_stall_cleared',
    ts: eventOpts?.ts ?? Date.now(),
    ...state.context,
  });
}

// Only the feed needs a heartbeat; the result has nothing to keep from one. Claude Code sends
// its bookkeeping frames in bursts, and the freshness clock counts whole seconds, so one
// heartbeat a second tells the feed all that a burst can.
export function recordHeartbeat(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['heartbeat']>[0],
): void {
  const ts = eventOpts?.ts ?? Date.now();
  if (
    state.lastHeartbeatTs !== null &&
    ts - state.lastHeartbeatTs < RUNNER_CALL_HEARTBEAT_INTERVAL_MS
  ) {
    return;
  }
  state.lastHeartbeatTs = ts;
  emit(state, { type: 'call_heartbeat', ts, ...state.context }, false);
}
