import { error } from '../../../utils/error.js';
import { assertNever } from '../../../utils/type-guards.js';
import { boundRunnerCallToolUse } from '../bounded-payload.js';
import {
  createRunnerCallDeltaLimiter,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  runnerCallItemLimit,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
} from '../output-limit.js';
import { isRunnerCallTerminalEvent } from '../status.js';
import type { RunnerCallEvent, RunnerCallResult } from '../types.js';
import { unknownUpstreamWarningInput } from '../unknown-upstream.js';
import { applyRunnerCallUsageSample } from '../usage/accumulate.js';
import { eventContext, assertSameCall } from './identity.js';
import {
  type RunnerCallCollectionState,
  appendWarning,
  applyStderrEvent,
  noteLimit,
  emitStderrFailureWarning,
} from './state.js';

export function collectRunnerCallResult(events: Iterable<RunnerCallEvent>): RunnerCallResult {
  const state: RunnerCallCollectionState = {
    context: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
    error: null,
    partial: null,
    terminalStatus: null,
    emittedLimitWarningCodes: new Set<string>(),
    stderrLimiter: createRunnerCallDeltaLimiter({
      code: 'runner_call_stderr_limit',
      label: 'The tool error output',
      maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
    }),
    stderrPreview: '',
    stderrWarningEmitted: false,
    artifactCount: 0,
    warningCount: 0,
    unknownUpstreamCount: 0,
  };

  for (const event of events) {
    if (state.context === null) {
      state.context = eventContext(event);
    } else {
      assertSameCall(state.context, event);
    }
    if (state.terminalStatus !== null && !isRunnerCallTerminalEvent(event)) {
      appendWarning(state, {
        code: 'event_after_terminal',
        severity: 'debug',
        source: 'system',
        surface: 'debug',
        message: `Ignored non-terminal event after ${state.terminalStatus} terminal status`,
      });
      continue;
    }
    applyRunnerCallEvent(state, event);
  }

  if (state.context === null) {
    throw error(
      'runner-call-empty',
      'Cannot collect runner call result from an empty event stream',
    );
  }

  const status = state.terminalStatus ?? 'incomplete';
  const startedAt = state.startedAt ?? 0;
  const endedAt = state.endedAt ?? Date.now();
  const durationMs = state.durationMs ?? Math.max(0, endedAt - startedAt);
  const missingTerminal =
    state.terminalStatus === null
      ? { code: 'missing_terminal_event', message: 'Runner call ended without a terminal event' }
      : null;

  const common = {
    callId: state.context.callId,
    role: state.context.role,
    backendKind: state.context.backendKind,
    ...(state.context.runnerName !== undefined && { runnerName: state.context.runnerName }),
    ...(state.context.model !== undefined && { model: state.context.model }),
    ...(state.context.axes !== undefined && { axes: state.context.axes }),
    ...(state.context.attempt !== undefined && { attempt: state.context.attempt }),
    ...(state.context.attemptId !== undefined && { attemptId: state.context.attemptId }),
    ...(state.context.transport !== undefined && { transport: state.context.transport }),
    ...(state.context.sessionScope !== undefined && { sessionScope: state.context.sessionScope }),
    ...(state.context.invocationIdentity !== undefined && {
      invocationIdentity: state.context.invocationIdentity,
    }),
    ...(state.context.taskId !== undefined && { taskId: state.context.taskId }),
    ...(state.context.usageBoundary !== undefined && {
      usageBoundary: state.context.usageBoundary,
    }),
    status,
    startedAt,
    endedAt,
    durationMs,
    text: state.text,
    usage: state.usage,
    nativeSessionId: state.nativeSessionId,
    toolUses: state.toolUses,
    artifacts: state.artifacts,
    warnings: state.warnings,
  };

  if (status === 'completed') {
    return {
      ...common,
      status,
      error: null,
      partial: false,
      ...(state.structured !== undefined && { structured: state.structured }),
    };
  }

  return {
    ...common,
    status,
    error: state.error ??
      missingTerminal ?? {
        code: 'missing_failure_error',
        message: `Runner call ended with ${status} status without an error`,
      },
    partial: state.partial ?? true,
  };
}

function applyRunnerCallEvent(state: RunnerCallCollectionState, event: RunnerCallEvent): void {
  switch (event.type) {
    case 'call_started':
      state.startedAt = event.ts;
      return;
    case 'call_text_delta':
      if (event.subagentId === undefined && contributesToResultText(event.channel)) {
        // An empty assistant final closes a message but has no text to replace its streamed partial.
        if (event.semantics !== 'final') state.text += event.text;
        else if (event.channel !== 'assistant' || event.text.length > 0) state.text = event.text;
      }
      return;
    case 'call_stderr_delta':
      applyStderrEvent(state, event.text);
      return;
    case 'call_tool_use_done':
      {
        const bounded = boundRunnerCallToolUse(event.toolUse);
        state.toolUses.push(bounded.value);
        if (bounded.limit !== null) noteLimit(state, bounded.limit);
      }
      return;
    case 'call_usage':
      state.usage = applyRunnerCallUsageSample(state.usage, {
        semantics: event.semantics,
        usage: event.usage,
      });
      return;
    case 'call_session_id':
      state.nativeSessionId = event.nativeSessionId;
      return;
    case 'call_artifact':
      if (state.artifactCount >= RUNNER_CALL_ARTIFACT_MAX_ITEMS) {
        noteLimit(
          state,
          runnerCallItemLimit({
            code: 'runner_call_artifact_count_limit',
            label: 'artifacts',
            maxItems: RUNNER_CALL_ARTIFACT_MAX_ITEMS,
          }),
        );
        return;
      }
      state.artifactCount += 1;
      state.artifacts.push(event.artifact);
      return;
    case 'call_warning':
      appendWarning(state, event.warning);
      return;
    case 'call_error':
      emitStderrFailureWarning(state);
      state.terminalStatus = event.status;
      state.error = event.error;
      state.partial = event.partial;
      state.endedAt = event.endedAt;
      state.durationMs = event.durationMs;
      if (state.startedAt === null) state.startedAt = event.startedAt;
      if (event.usage !== null) {
        state.usage = applyRunnerCallUsageSample(state.usage, {
          semantics: 'final',
          usage: event.usage,
        });
      }
      state.nativeSessionId = event.nativeSessionId;
      return;
    case 'call_completed':
      state.terminalStatus = event.status;
      state.error = event.error;
      state.partial = event.partial;
      state.endedAt = event.endedAt;
      state.durationMs = event.durationMs;
      if (state.startedAt === null) state.startedAt = event.startedAt;
      if (event.usage !== null) {
        state.usage = applyRunnerCallUsageSample(state.usage, {
          semantics: 'final',
          usage: event.usage,
        });
      }
      state.nativeSessionId = event.nativeSessionId;
      state.structured = event.structured;
      return;
    case 'call_unknown_upstream':
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
      appendWarning(state, unknownUpstreamWarningInput(event));
      return;
    case 'call_tool_use_delta':
    case 'call_runtime_status':
    case 'call_stalled':
    case 'call_stall_cleared':
    case 'call_heartbeat':
      return;
    default:
      assertNever(event);
  }
}

function contributesToResultText(
  channel: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'],
): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
