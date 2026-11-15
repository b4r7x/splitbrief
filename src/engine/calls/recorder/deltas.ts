import { randomUUID } from 'node:crypto';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { boundRunnerCallToolUse } from '../bounded-payload.js';
import {
  RUNNER_CALL_STDERR_MAX_BYTES,
  runnerCallToolUseCountLimit,
  runnerCallToolUseStopLimit,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS,
} from '../output-limit.js';
import { redactRunnerCallToolUse } from '../redact-event.js';
import {
  appendStderrPreview,
  stderrDiagnosticWarning,
  stderrLooksWarningLike,
} from '../stderr-diagnostics.js';
import type { RunnerCallEventInput } from '../types.js';
import { emit, noteLimit } from './emit.js';
import { createTextLimiter } from './fields.js';
import type { RunnerCallRecorder, RunnerCallRecorderState } from './types.js';

export function recordText(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['text']>[0],
): void {
  const isSubagent = eventOpts.subagentId !== undefined;
  if (!isSubagent && eventOpts.semantics === 'final') state.textLimiter = createTextLimiter();
  const text = state.redactCredential(eventOpts.text);
  // An explicit `delta` is a partial slice of one record: the byte budget
  // bounds it, the event budget counts records.
  const accepted = (isSubagent ? state.subagentTextLimiter : state.textLimiter).accept(text);
  const textEvent = (eventText: string): RunnerCallEventInput => ({
    type: 'call_text_delta',
    ts: eventOpts.ts ?? Date.now(),
    ...state.context,
    channel: eventOpts.channel,
    text: eventText,
    ...(eventOpts.subagentId !== undefined && { subagentId: eventOpts.subagentId }),
    ...(eventOpts.semantics !== undefined && { semantics: eventOpts.semantics }),
  });
  const recorded =
    accepted.text.length > 0 || (eventOpts.semantics === 'final' && accepted.limit === null);
  if (isSubagent) {
    if (recorded) emit(state, textEvent(accepted.text));
    if (accepted.limit !== null) noteLimit(state, accepted.limit);
  } else if (text.length > 0 || eventOpts.semantics === 'final') {
    // The answer is kept whole; only its recorded copy is cut.
    const event = textEvent(text);
    emit(
      state,
      event,
      true,
      accepted.limit === null ? event : recorded ? textEvent(accepted.text) : null,
    );
  }
}

export function recordStderr(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['stderr']>[0],
): void {
  const accepted = state.stderrLimiter.accept(state.redactCredential(eventOpts.text));
  if (accepted.text.length > 0) {
    state.stderrPreview = appendStderrPreview(
      state.stderrPreview,
      sanitizeTerminalDiagnosticText(accepted.text, { maxChars: RUNNER_CALL_STDERR_MAX_BYTES }),
    );
    if (stderrLooksWarningLike(accepted.text)) {
      emitStderrDiagnosticWarning(state, 'stderr_diagnostic', accepted.text);
    }
    emit(state, {
      type: 'call_stderr_delta',
      ts: eventOpts.ts ?? Date.now(),
      ...state.context,
      channel: 'stderr',
      text: accepted.text,
    });
  }
  if (accepted.limit !== null) noteLimit(state, accepted.limit);
}

export function emitStderrDiagnosticWarning(
  state: RunnerCallRecorderState,
  code: string,
  message: string,
): void {
  if (state.stderrWarningEmitted) return;
  state.stderrWarningEmitted = true;
  emit(state, {
    type: 'call_warning',
    ts: Date.now(),
    ...state.context,
    warning: stderrDiagnosticWarning(code, message),
  });
}

export function recordToolUseDelta(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['toolUseDelta']>[0],
): void {
  const toolUseId =
    eventOpts.toolUseId ??
    (eventOpts.stage === 'started' ||
    state.activeToolUse === null ||
    (eventOpts.name !== null &&
      state.activeToolUse.name !== null &&
      eventOpts.name !== state.activeToolUse.name)
      ? randomUUID()
      : state.activeToolUse.id);
  state.activeToolUse = {
    id: toolUseId,
    name: eventOpts.name ?? state.activeToolUse?.name ?? null,
  };
  const accepted = state.toolDeltaLimiter.accept(state.redactCredential(eventOpts.inputDelta));
  if (accepted.text.length > 0 || accepted.limit === null) {
    emit(state, {
      type: 'call_tool_use_delta',
      ts: eventOpts.ts ?? Date.now(),
      ...state.context,
      channel: 'tool',
      toolUseId: state.activeToolUse.id,
      name: state.activeToolUse.name,
      inputDelta: accepted.text,
    });
  }
  if (accepted.limit !== null) noteLimit(state, accepted.limit);
}

export function recordToolUseDone(
  state: RunnerCallRecorderState,
  eventOpts: Parameters<RunnerCallRecorder['toolUseDone']>[0],
): void {
  const toolUse =
    eventOpts.toolUse.id === null
      ? {
          ...eventOpts.toolUse,
          id:
            state.activeToolUse !== null &&
            (state.activeToolUse.name === null ||
              state.activeToolUse.name === eventOpts.toolUse.name)
              ? state.activeToolUse.id
              : randomUUID(),
        }
      : eventOpts.toolUse;
  if (state.activeToolUse?.id === toolUse.id) state.activeToolUse = null;
  // Past the cap the result keeps the tool results it has, and the feed
  // still hears every completion: a call does not go quiet at its 257th.
  const kept = state.toolUseDoneCount < RUNNER_CALL_TOOL_USE_MAX_ITEMS;
  const bounded = boundRunnerCallToolUse(redactRunnerCallToolUse(toolUse, state.redactCredential));
  state.recentToolUses.push(bounded.value);
  if (state.recentToolUses.length > RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS) {
    state.recentToolUses.shift();
  }
  state.toolUseDoneCount += 1;
  if (!kept) noteLimit(state, runnerCallToolUseCountLimit());
  if (bounded.limit !== null) noteLimit(state, bounded.limit);
  emit(
    state,
    {
      type: 'call_tool_use_done',
      ts: eventOpts.ts ?? Date.now(),
      ...state.context,
      channel: 'tool',
      toolUse: bounded.value,
    },
    kept,
  );
  stopAtToolUseLimit(state);
}

function stopAtToolUseLimit(state: RunnerCallRecorderState): void {
  const max = state.stopAfterToolUses;
  if (max === undefined || state.toolUseDoneCount <= max || state.toolUseStop !== null) return;
  state.toolUseStop = runnerCallToolUseStopLimit(max, state.recentToolUses);
  state.onLimit?.();
}
