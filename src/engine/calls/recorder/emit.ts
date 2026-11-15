import { error } from '../../../utils/error.js';
import { collectRunnerCallResult } from '../collector/collect.js';
import {
  RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
  type RunnerCallOutputLimit,
  runnerCallByteLimitMessage,
  runnerCallLimitWarning,
} from '../output-limit.js';
import { redactRunnerCallEventInput } from '../redact-event.js';
import { RunnerCallEventSchema, RunnerCallResultSchema } from '../schema.js';
import { isRunnerCallTerminalEvent } from '../status.js';
import type { RunnerCallEvent, RunnerCallEventInput, RunnerCallResult } from '../types.js';
import { formatZodIssues, runnerCallUnknownUpstreamPreview } from '../unknown-upstream.js';
import { metadataString, nowOrTimestamp, recordType } from './fields.js';
import type { RunnerCallRecorderState } from './types.js';

/**
 * An event the result does not keep still reaches the feed. The result reads the whole event,
 * until the streamed text passes the retained bound and its middle drops; the feed and the call
 * log get `recordInput`, a copy cut to its record bound, or nothing.
 */
export function emit(
  state: RunnerCallRecorderState,
  input: RunnerCallEventInput,
  retain = true,
  recordInput: RunnerCallEventInput | null = input,
): void {
  const event = validateRunnerCallEvent(
    state,
    redactRunnerCallEventInput(input, state.redactCredential),
  );
  if (state.hasTerminalEvent) return;
  if (isRunnerCallTerminalEvent(event)) state.hasTerminalEvent = true;
  const dropped = retain && state.events.push(event);
  if (recordInput !== null) {
    state.onEvent?.(
      recordInput === input
        ? event
        : validateRunnerCallEvent(
            state,
            redactRunnerCallEventInput(recordInput, state.redactCredential),
          ),
    );
  }
  if (dropped) {
    noteLimit(state, {
      code: 'runner_call_retained_text_limit',
      message: runnerCallByteLimitMessage('The reply', RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES),
      maxBytes: RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
    });
  }
}

/** No limit ends the call; each limit is noted once, on `debug`. */
export function noteLimit(state: RunnerCallRecorderState, limit: RunnerCallOutputLimit): void {
  if (state.emittedLimitWarnings.has(limit.code)) return;
  state.emittedLimitWarnings.add(limit.code);
  emit(state, {
    type: 'call_warning',
    ts: Date.now(),
    ...state.context,
    warning: runnerCallLimitWarning(limit),
  });
}

export function snapshot(state: RunnerCallRecorderState): RunnerCallResult {
  return validateRunnerCallResult(state, collectRunnerCallResult(state.events.events()));
}

function validateRunnerCallEvent(
  state: RunnerCallRecorderState,
  input: RunnerCallEventInput,
): RunnerCallEvent {
  const parsed = RunnerCallEventSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  return invalidUpstreamEvent(state, input, parsed.error.issues);
}

function validateRunnerCallResult(
  state: RunnerCallRecorderState,
  result: RunnerCallResult,
): RunnerCallResult {
  const parsed = RunnerCallResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  throw error('runner-call-result-invalid', 'Runner call result failed schema validation', {
    callId: state.context.callId,
    issues: formatZodIssues(parsed.error.issues),
  });
}

function invalidUpstreamEvent(
  state: RunnerCallRecorderState,
  input: RunnerCallEventInput,
  issues: Parameters<typeof runnerCallUnknownUpstreamPreview>[0]['issues'],
): RunnerCallEvent {
  const upstreamType = metadataString(recordType(input));
  return {
    type: 'call_unknown_upstream',
    ts: nowOrTimestamp(input),
    ...state.context,
    rawPreview: runnerCallUnknownUpstreamPreview({
      label: 'Invalid runner call event',
      value: input,
      issues,
    }),
    backendMetadata: {
      backendKind: state.context.backendKind,
      source: 'recorder',
      ...(upstreamType !== undefined && { upstreamType }),
    },
  };
}
