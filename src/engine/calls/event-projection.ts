import type { Phase } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import { assertNever } from '../../utils/type-guards.js';
import type { EngineEvent } from '../events/types.js';
import { boundedRunnerCallMessage } from './status.js';
import type { RunnerCallEvent } from './types.js';

interface RunnerCallEventProjectionOptions {
  phase: Phase;
  taskId?: TaskId | undefined;
  sequence: number;
}

type ProjectedRunnerCallEvent = Extract<EngineEvent, { type: `runner_call_${string}` }>;

function baseProjection(
  event: RunnerCallEvent,
  opts: RunnerCallEventProjectionOptions,
): Omit<ProjectedRunnerCallEvent, 'type'> {
  return {
    ts: event.ts,
    phase: opts.phase,
    ...(opts.taskId !== undefined && { taskId: opts.taskId }),
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    sequence: opts.sequence,
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
  };
}

export function projectRunnerCallEvent(
  event: RunnerCallEvent,
  opts: RunnerCallEventProjectionOptions,
): ProjectedRunnerCallEvent | null {
  const base = baseProjection(event, opts);
  switch (event.type) {
    case 'call_started':
      return { type: 'runner_call_started', ...base };
    case 'call_text_delta':
      return { type: 'runner_call_text_delta', ...base, text: event.text };
    case 'call_stderr_delta':
      return {
        type: 'runner_call_warning',
        ...base,
        warning: { code: 'stderr', message: boundedRunnerCallMessage(event.text) },
      };
    case 'call_tool_use_delta':
      return {
        type: 'runner_call_tool_use',
        ...base,
        ...(event.toolUseId !== null && { toolUseId: event.toolUseId }),
        ...(event.name !== null && { name: event.name }),
        inputDelta: event.inputDelta,
      };
    case 'call_tool_use_done':
      return { type: 'runner_call_tool_use', ...base, toolUse: event.toolUse };
    case 'call_usage':
      return {
        type: 'runner_call_usage',
        ...base,
        usage: event.usage,
        semantics: event.semantics,
      };
    case 'call_session_id':
      return {
        type: 'runner_call_session_id',
        ...base,
        nativeSessionId: event.nativeSessionId,
      };
    case 'call_artifact':
      return { type: 'runner_call_artifact', ...base, artifact: event.artifact };
    case 'call_warning':
      return {
        type: 'runner_call_warning',
        ...base,
        warning: {
          ...event.warning,
          message: boundedRunnerCallMessage(event.warning.message),
        },
      };
    case 'call_error':
      return {
        type: 'runner_call_error',
        ...base,
        status: event.status,
        error: event.error,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        partial: event.partial,
        usage: event.usage,
        nativeSessionId: event.nativeSessionId,
      };
    case 'call_completed':
      return {
        type: 'runner_call_completed',
        ...base,
        status: event.status,
        error: event.error,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        partial: event.partial,
        usage: event.usage,
        nativeSessionId: event.nativeSessionId,
      };
    case 'call_unknown_upstream':
      return {
        type: 'runner_call_warning',
        ...base,
        warning: {
          code: 'unknown_upstream',
          message: boundedRunnerCallMessage(event.rawPreview),
        },
      };
    default:
      return assertNever(event);
  }
}
