import { error } from '../../utils/error.js';
import { assertNever } from '../../utils/type-guards.js';
import { isRunnerCallTerminalEvent } from './status.js';
import { applyRunnerCallUsageSample } from './usage.js';
import { normalizeRunnerCallWarning } from './warnings.js';
import {
  boundRunnerCallArtifact,
  boundRunnerCallToolUse,
  createRunnerCallDeltaLimiter,
  runnerCallLimitWarning,
  sanitizeRunnerCallRawPreview,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
  RUNNER_CALL_WARNING_MAX_ITEMS,
  type RunnerCallOutputLimit,
} from './output-limit.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';
import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallStatus,
  RunnerCallUsage,
  RunnerCallWarning,
} from './types.js';

interface RunnerCallCollectionState {
  context: RunnerCallContext | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  text: string;
  usage: RunnerCallUsage | null;
  nativeSessionId: string | null;
  toolUses: RunnerCallResult['toolUses'];
  artifacts: RunnerCallResult['artifacts'];
  warnings: RunnerCallWarning[];
  error: RunnerCallError | null;
  partial: boolean | null;
  terminalStatus: RunnerCallStatus | null;
  resultLimit: RunnerCallOutputLimit | null;
  emittedLimitWarningCodes: Set<string>;
  textLimiter: ReturnType<typeof createRunnerCallDeltaLimiter>;
  stderrLimiter: ReturnType<typeof createRunnerCallDeltaLimiter>;
  toolDeltaLimiter: ReturnType<typeof createRunnerCallDeltaLimiter>;
  stderrPreview: string;
  stderrWarningEmitted: boolean;
  toolUseDoneCount: number;
  artifactCount: number;
  warningCount: number;
  unknownUpstreamCount: number;
}

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
    resultLimit: null,
    emittedLimitWarningCodes: new Set<string>(),
    textLimiter: createTextLimiter(),
    stderrLimiter: createRunnerCallDeltaLimiter({
      code: 'runner_call_stderr_limit',
      label: 'runner call stderr diagnostics',
      maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
    }),
    toolDeltaLimiter: createRunnerCallDeltaLimiter({
      code: 'runner_call_tool_delta_limit',
      label: 'runner call tool deltas',
    }),
    stderrPreview: '',
    stderrWarningEmitted: false,
    toolUseDoneCount: 0,
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

  const status = state.resultLimit !== null ? 'truncated' : (state.terminalStatus ?? 'incomplete');
  const startedAt = state.startedAt ?? 0;
  const endedAt = state.endedAt ?? Date.now();
  const durationMs = state.durationMs ?? Math.max(0, endedAt - startedAt);
  const missingTerminal =
    state.terminalStatus === null
      ? { code: 'missing_terminal_event', message: 'Runner call ended without a terminal event' }
      : null;
  const resultLimitError =
    state.resultLimit === null
      ? null
      : { code: state.resultLimit.code, message: state.resultLimit.message };

  const common = {
    callId: state.context.callId,
    role: state.context.role,
    backendKind: state.context.backendKind,
    ...(state.context.runnerName !== undefined && { runnerName: state.context.runnerName }),
    ...(state.context.model !== undefined && { model: state.context.model }),
    ...(state.context.attempt !== undefined && { attempt: state.context.attempt }),
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
    };
  }

  return {
    ...common,
    status,
    error: state.error ??
      resultLimitError ??
      missingTerminal ?? {
        code: 'missing_failure_error',
        message: `Runner call ended with ${status} status without an error`,
      },
    partial: state.resultLimit !== null ? true : (state.partial ?? true),
  };
}

function eventContext(event: RunnerCallEvent): RunnerCallContext {
  return {
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
  };
}

function assertSameCall(context: RunnerCallContext, event: RunnerCallEvent): void {
  if (
    context.callId === event.callId &&
    context.role === event.role &&
    context.backendKind === event.backendKind
  ) {
    return;
  }

  throw error(
    'runner-call-mixed-events',
    'Runner call collector received events from another call',
    {
      expectedCallId: context.callId,
      actualCallId: event.callId,
    },
  );
}

function applyRunnerCallEvent(state: RunnerCallCollectionState, event: RunnerCallEvent): void {
  switch (event.type) {
    case 'call_started':
      state.startedAt = event.ts;
      return;
    case 'call_text_delta':
      if (contributesToResultText(event.channel)) {
        const limiter = event.semantics === 'final' ? createTextLimiter() : state.textLimiter;
        const accepted = limiter.accept(event.text);
        if (event.semantics === 'final') {
          state.text = accepted.text;
          state.textLimiter = limiter;
          if (accepted.limit === null && state.resultLimit?.code === 'runner_call_text_limit') {
            state.resultLimit = null;
          }
        } else {
          state.text += accepted.text;
        }
        if (accepted.limit !== null) noteLimit(state, accepted.limit, true);
      }
      return;
    case 'call_stderr_delta':
      applyStderrEvent(state, event.text);
      return;
    case 'call_tool_use_delta':
      applyToolDeltaEvent(state, event.inputDelta);
      return;
    case 'call_tool_use_done':
      if (state.toolUseDoneCount >= RUNNER_CALL_TOOL_USE_MAX_ITEMS) {
        noteLimit(
          state,
          itemLimit({
            code: 'runner_call_tool_use_count_limit',
            label: 'runner call tool results',
            maxItems: RUNNER_CALL_TOOL_USE_MAX_ITEMS,
            nextItemCount: state.toolUseDoneCount + 1,
          }),
          true,
        );
        return;
      }
      state.toolUseDoneCount += 1;
      {
        const bounded = boundRunnerCallToolUse(event.toolUse);
        state.toolUses.push(bounded.value);
        if (bounded.limit !== null) noteLimit(state, bounded.limit, true);
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
          itemLimit({
            code: 'runner_call_artifact_count_limit',
            label: 'runner call artifacts',
            maxItems: RUNNER_CALL_ARTIFACT_MAX_ITEMS,
            nextItemCount: state.artifactCount + 1,
          }),
          true,
        );
        return;
      }
      state.artifactCount += 1;
      {
        const bounded = boundRunnerCallArtifact(event.artifact);
        state.artifacts.push(bounded.value);
        if (bounded.limit !== null) noteLimit(state, bounded.limit, true);
      }
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
      return;
    case 'call_unknown_upstream':
      if (state.unknownUpstreamCount >= RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS) {
        noteLimit(
          state,
          itemLimit({
            code: 'runner_call_unknown_upstream_count_limit',
            label: 'runner call unknown upstream diagnostics',
            maxItems: RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
            nextItemCount: state.unknownUpstreamCount + 1,
          }),
          false,
        );
        return;
      }
      state.unknownUpstreamCount += 1;
      appendWarning(state, {
        code: 'unknown_upstream',
        severity: 'warning',
        source: event.backendMetadata.source ?? 'upstream',
        surface: 'activity',
        parser: event.backendMetadata.parser,
        upstreamType: event.backendMetadata.upstreamType,
        channel: event.backendMetadata.channel,
        message: sanitizeRunnerCallRawPreview(event.rawPreview),
      });
      return;
    default:
      assertNever(event);
  }
}

function appendWarning(
  state: RunnerCallCollectionState,
  warning: Parameters<typeof normalizeRunnerCallWarning>[0],
): void {
  const isLimitWarning =
    warning.source === 'system' &&
    warning.code.startsWith('runner_call_') &&
    warning.code.endsWith('_limit');
  if (state.warningCount >= RUNNER_CALL_WARNING_MAX_ITEMS && !isLimitWarning) {
    noteLimit(
      state,
      itemLimit({
        code: 'runner_call_warning_count_limit',
        label: 'runner call warnings',
        maxItems: RUNNER_CALL_WARNING_MAX_ITEMS,
        nextItemCount: state.warningCount + 1,
      }),
      false,
    );
    return;
  }
  const normalized = normalizeRunnerCallWarning(warning);
  if (normalized.source === 'stderr') state.stderrWarningEmitted = true;
  if (!isLimitWarning) state.warningCount += 1;
  state.warnings.push(normalized);
}

function noteLimit(
  state: RunnerCallCollectionState,
  limit: RunnerCallOutputLimit,
  resultIncomplete: boolean,
): void {
  if (resultIncomplete && state.resultLimit === null) state.resultLimit = limit;
  if (state.emittedLimitWarningCodes.has(limit.code)) return;
  state.emittedLimitWarningCodes.add(limit.code);
  appendWarning(state, runnerCallLimitWarning(limit));
}

function itemLimit(opts: {
  code: string;
  label: string;
  maxItems: number;
  nextItemCount: number;
}): RunnerCallOutputLimit {
  return {
    code: opts.code,
    message: `${opts.label} exceeded ${opts.maxItems} items and was truncated`,
    eventsSeen: opts.nextItemCount,
    maxEvents: opts.maxItems,
  };
}

function createTextLimiter(): ReturnType<typeof createRunnerCallDeltaLimiter> {
  return createRunnerCallDeltaLimiter({
    code: 'runner_call_text_limit',
    label: 'runner call text',
  });
}

function applyToolDeltaEvent(state: RunnerCallCollectionState, inputDelta: string): void {
  const accepted = state.toolDeltaLimiter.accept(inputDelta, { countEvent: true });
  if (accepted.limit !== null) noteLimit(state, accepted.limit, true);
}

function applyStderrEvent(state: RunnerCallCollectionState, text: string): void {
  const accepted = state.stderrLimiter.accept(text);
  if (accepted.text.length > 0) {
    state.stderrPreview = sanitizeTerminalDiagnosticText(
      `${state.stderrPreview}${accepted.text}\n`,
      {
        maxChars: RUNNER_CALL_STDERR_MAX_BYTES,
      },
    );
    if (stderrLooksWarningLike(accepted.text)) {
      emitStderrDiagnosticWarning(state, 'stderr_diagnostic', accepted.text);
    }
  }
  if (accepted.limit !== null) noteLimit(state, accepted.limit, false);
}

function stderrLooksWarningLike(text: string): boolean {
  return /\b(error|failed|failure|fatal|exception|warning|warn|deprecated)\b/i.test(text);
}

function emitStderrDiagnosticWarning(
  state: RunnerCallCollectionState,
  code: string,
  message: string,
): void {
  if (state.stderrWarningEmitted) return;
  state.stderrWarningEmitted = true;
  appendWarning(state, {
    code,
    severity: 'warning',
    source: 'stderr',
    surface: 'status',
    channel: 'stderr',
    message: sanitizeTerminalDiagnosticText(message),
  });
}

function emitStderrFailureWarning(state: RunnerCallCollectionState): void {
  if (state.stderrPreview.trim().length === 0) return;
  emitStderrDiagnosticWarning(state, 'stderr_on_failure', state.stderrPreview);
}

function contributesToResultText(
  channel: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'],
): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
