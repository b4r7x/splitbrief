import { randomUUID } from 'node:crypto';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { error } from '../../../utils/error.js';
import {
  boundRunnerCallStructured,
  boundRunnerCallToolUse,
  boundRunnerCallArtifact,
  sanitizeRunnerCallRawPreview,
} from '../bounded-payload.js';
import { collectRunnerCallResult } from '../collector/collect.js';
import {
  createHeadTailEventLog,
  RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
  type RunnerCallOutputLimit,
  createRunnerCallDeltaLimiter,
  RUNNER_CALL_STDERR_MAX_BYTES,
  runnerCallByteLimitMessage,
  runnerCallLimitError,
  runnerCallLimitWarning,
  runnerCallToolUseStopLimit,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS,
  runnerCallToolUseCountLimit,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  runnerCallItemLimit,
  RUNNER_CALL_WARNING_MAX_ITEMS,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
} from '../output-limit.js';
import {
  type RunnerCallToolUse,
  redactRunnerCallEventInput,
  redactRunnerCallToolUse,
  redactRunnerCallWarningInput,
} from '../redact-event.js';
import { RunnerCallEventSchema, RunnerCallResultSchema } from '../schema.js';
import {
  createRunnerCallCredentialRedactor,
  isRunnerCallTerminalEvent,
  runnerCallCompletedEvent,
  boundedRunnerCallMessage,
  runnerCallErrorEvent,
} from '../status.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallEventInput,
  RunnerCallResult,
  RunnerCallUsage,
  RunnerCallFailureStatus,
  RunnerCallError,
} from '../types.js';
import { formatZodIssues, runnerCallUnknownUpstreamPreview } from '../unknown-upstream.js';
import { normalizeRunnerCallWarning } from '../warnings.js';
import {
  snapshotRunnerCallContext,
  streamedTextBytes,
  createTextLimiter,
  hasPartialResult,
  boundedRunnerCallProviderType,
  runnerCallRawTail,
  metadataString,
  recordType,
  nowOrTimestamp,
} from './fields.js';
import type { RunnerCallRecorder } from './types.js';

const RUNNER_CALL_HEARTBEAT_INTERVAL_MS = 1_000;

export function createRunnerCallRecorder(opts: {
  context: RunnerCallContext;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  /** The seat's opt-in `maxToolCalls`: the tool use after it stops the call through `onLimit`. */
  stopAfterToolUses?: number | undefined;
  onLimit?: (() => void) | undefined;
  startedAt?: number | undefined;
  credentialValues?: readonly string[] | undefined;
}): RunnerCallRecorder {
  const context = snapshotRunnerCallContext(opts.context);
  const startedAt = opts.startedAt ?? Date.now();
  const redactCredential = createRunnerCallCredentialRedactor(opts.credentialValues ?? []);
  const events = createHeadTailEventLog(RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES, streamedTextBytes);
  let hasTerminalEvent = false;
  let toolUseDoneCount = 0;
  let artifactCount = 0;
  let warningCount = 0;
  let unknownUpstreamCount = 0;
  let stderrPreview = '';
  let stderrWarningEmitted = false;
  let lastNativeSessionId: string | null = null;
  let lastResolvedModel: string | undefined;
  let lastHeartbeatTs: number | null = null;
  let activeToolUse: { id: string; name: string | null } | null = null;
  const recentToolUses: RunnerCallToolUse[] = [];
  let toolUseStop: RunnerCallOutputLimit | null = null;
  const emittedLimitWarnings = new Set<string>();
  let textLimiter = createTextLimiter();
  const subagentTextLimiter = createTextLimiter();
  const stderrLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_stderr_limit',
    label: 'The tool error output',
    maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
  });
  const toolDeltaLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_tool_delta_limit',
    label: 'The streamed tool input',
  });

  /**
   * An event the result does not keep still reaches the feed. The result reads the whole event,
   * until the streamed text passes the retained bound and its middle drops; the feed and the call
   * log get `recordInput`, a copy cut to its record bound, or nothing.
   */
  function emit(
    input: RunnerCallEventInput,
    retain = true,
    recordInput: RunnerCallEventInput | null = input,
  ): void {
    const event = validateRunnerCallEvent(redactRunnerCallEventInput(input, redactCredential));
    if (hasTerminalEvent && !isRunnerCallTerminalEvent(event)) return;
    if (isRunnerCallTerminalEvent(event)) {
      if (hasTerminalEvent) return;
      hasTerminalEvent = true;
    }
    const dropped = retain && events.push(event);
    if (recordInput !== null) {
      opts.onEvent?.(
        recordInput === input
          ? event
          : validateRunnerCallEvent(redactRunnerCallEventInput(recordInput, redactCredential)),
      );
    }
    if (dropped) {
      noteLimit({
        code: 'runner_call_retained_text_limit',
        message: runnerCallByteLimitMessage('The reply', RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES),
        maxBytes: RUNNER_CALL_RETAINED_OUTPUT_MAX_BYTES,
      });
    }
  }

  function snapshot(): RunnerCallResult {
    return validateRunnerCallResult(collectRunnerCallResult(events.events()));
  }

  function currentTerminalDefaults(opts: {
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
  }): {
    usage: RunnerCallUsage | null;
    nativeSessionId: string | null;
    partial: boolean;
  } {
    const current = snapshot();
    return {
      usage: opts.usage === undefined ? current.usage : opts.usage,
      nativeSessionId:
        opts.nativeSessionId === undefined ? current.nativeSessionId : opts.nativeSessionId,
      partial: hasPartialResult(current),
    };
  }

  function finishCompleted(
    finishOpts: {
      usage?: RunnerCallUsage | null | undefined;
      nativeSessionId?: string | null | undefined;
      endedAt?: number | undefined;
      structured?: unknown;
    } = {},
  ): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    const defaults = currentTerminalDefaults(finishOpts);
    if (toolUseStop !== null) {
      return finishFailed({
        status: 'truncated',
        error: runnerCallLimitError(toolUseStop),
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        partial: true,
        endedAt: finishOpts.endedAt,
      });
    }
    noteCutText();
    const terminal = {
      startedAt,
      endedAt: finishOpts.endedAt ?? Date.now(),
      usage: defaults.usage,
      nativeSessionId: defaults.nativeSessionId,
      ...(finishOpts.structured !== undefined && { structured: finishOpts.structured }),
    };
    const completed = runnerCallCompletedEvent(context, terminal);
    const structured =
      finishOpts.structured === undefined ? null : boundRunnerCallStructured(finishOpts.structured);
    if (structured !== null && structured.limit !== null) {
      noteLimit(structured.limit);
      emit(
        completed,
        true,
        runnerCallCompletedEvent(context, { ...terminal, structured: structured.value }),
      );
    } else {
      emit(completed);
    }
    return snapshot();
  }

  function finishFailed(finishOpts: {
    status: RunnerCallFailureStatus;
    error: RunnerCallError;
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
    partial?: boolean | undefined;
    endedAt?: number | undefined;
  }): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    const defaults = currentTerminalDefaults(finishOpts);
    const providerType =
      finishOpts.error.providerType === undefined
        ? undefined
        : boundedRunnerCallProviderType(redactCredential(finishOpts.error.providerType));
    const callError =
      toolUseStop === null
        ? {
            code: redactCredential(finishOpts.error.code),
            message: boundedRunnerCallMessage(finishOpts.error.message, opts.credentialValues),
            ...(finishOpts.error.status !== undefined && { status: finishOpts.error.status }),
            ...(providerType !== undefined && { providerType }),
          }
        : {
            code: toolUseStop.code,
            message: boundedRunnerCallMessage(
              runnerCallLimitError(toolUseStop).message,
              opts.credentialValues,
            ),
          };
    const rawTail = runnerCallRawTail(callError.message, opts.credentialValues);
    if (toolUseStop === null) noteCutText();
    emitStderrFailureWarning();
    emit(
      runnerCallErrorEvent(context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        status: toolUseStop === null ? finishOpts.status : 'truncated',
        error: callError,
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        partial: toolUseStop === null ? (finishOpts.partial ?? defaults.partial) : true,
        ...(rawTail !== undefined && { rawTail }),
      }),
    );
    return snapshot();
  }

  function finishIncomplete(finishOpts: { endedAt?: number | undefined } = {}): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    return finishFailed({
      status: 'incomplete',
      error: {
        code: 'missing_terminal_event',
        message: 'Runner call ended without a terminal event',
      },
      endedAt: finishOpts.endedAt,
    });
  }

  function validateRunnerCallEvent(input: RunnerCallEventInput): RunnerCallEvent {
    const parsed = RunnerCallEventSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    return invalidUpstreamEvent(input, parsed.error.issues);
  }

  function validateRunnerCallResult(result: RunnerCallResult): RunnerCallResult {
    const parsed = RunnerCallResultSchema.safeParse(result);
    if (parsed.success) return parsed.data;
    throw error('runner-call-result-invalid', 'Runner call result failed schema validation', {
      callId: context.callId,
      issues: formatZodIssues(parsed.error.issues),
    });
  }

  function invalidUpstreamEvent(
    input: RunnerCallEventInput,
    issues: Parameters<typeof runnerCallUnknownUpstreamPreview>[0]['issues'],
  ): RunnerCallEvent {
    const upstreamType = metadataString(recordType(input));
    return {
      type: 'call_unknown_upstream',
      ts: nowOrTimestamp(input),
      ...context,
      rawPreview: runnerCallUnknownUpstreamPreview({
        label: 'Invalid runner call event',
        value: input,
        issues,
      }),
      backendMetadata: {
        backendKind: context.backendKind,
        source: 'recorder',
        ...(upstreamType !== undefined && { upstreamType }),
      },
    };
  }

  emit({ type: 'call_started', ts: startedAt, ...context });

  /** No limit ends the call; each limit is noted once, on `debug`. */
  function noteLimit(limit: RunnerCallOutputLimit): void {
    if (emittedLimitWarnings.has(limit.code)) return;
    emittedLimitWarnings.add(limit.code);
    emit({
      type: 'call_warning',
      ts: Date.now(),
      ...context,
      warning: runnerCallLimitWarning(limit),
    });
  }

  // Judged on the text the call ends with: a final text that fits replaced
  // whatever the budget cut from the narration streamed before it.
  function noteCutText(): void {
    if (textLimiter.limit !== null) noteLimit(textLimiter.limit);
  }

  function stopAtToolUseLimit(): void {
    const max = opts.stopAfterToolUses;
    if (max === undefined || toolUseDoneCount <= max || toolUseStop !== null) return;
    toolUseStop = runnerCallToolUseStopLimit(max, recentToolUses);
    opts.onLimit?.();
  }

  function appendStderrPreview(text: string): void {
    const clean = sanitizeTerminalDiagnosticText(text, { maxChars: RUNNER_CALL_STDERR_MAX_BYTES });
    stderrPreview = sanitizeTerminalDiagnosticText(`${stderrPreview}${clean}\n`, {
      maxChars: RUNNER_CALL_STDERR_MAX_BYTES,
    });
  }

  function stderrLooksWarningLike(text: string): boolean {
    return /\b(error|failed|failure|fatal|exception|warning|warn|deprecated)\b/i.test(text);
  }

  function emitStderrDiagnosticWarning(code: string, message: string): void {
    if (stderrWarningEmitted) return;
    stderrWarningEmitted = true;
    emit({
      type: 'call_warning',
      ts: Date.now(),
      ...context,
      warning: {
        code,
        severity: 'warning',
        source: 'stderr',
        surface: 'status',
        channel: 'stderr',
        message: sanitizeTerminalDiagnosticText(message),
      },
    });
  }

  function emitStderrFailureWarning(): void {
    if (stderrPreview.trim().length === 0) return;
    emitStderrDiagnosticWarning('stderr_on_failure', stderrPreview);
  }

  return {
    context,
    startedAt,
    hasTerminal: () => hasTerminalEvent,
    text: (eventOpts) => {
      const isSubagent = eventOpts.subagentId !== undefined;
      if (!isSubagent && eventOpts.semantics === 'final') textLimiter = createTextLimiter();
      const text = redactCredential(eventOpts.text);
      // An explicit `delta` is a partial slice of one record: the byte budget
      // bounds it, the event budget counts records.
      const accepted = (isSubagent ? subagentTextLimiter : textLimiter).accept(text);
      const textEvent = (eventText: string): RunnerCallEventInput => ({
        type: 'call_text_delta',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        channel: eventOpts.channel,
        text: eventText,
        ...(eventOpts.subagentId !== undefined && { subagentId: eventOpts.subagentId }),
        ...(eventOpts.semantics !== undefined && { semantics: eventOpts.semantics }),
      });
      const recorded =
        accepted.text.length > 0 || (eventOpts.semantics === 'final' && accepted.limit === null);
      if (isSubagent) {
        if (recorded) emit(textEvent(accepted.text));
        if (accepted.limit !== null) noteLimit(accepted.limit);
      } else if (text.length > 0 || eventOpts.semantics === 'final') {
        // The answer is kept whole; only its recorded copy is cut.
        const event = textEvent(text);
        emit(
          event,
          true,
          accepted.limit === null ? event : recorded ? textEvent(accepted.text) : null,
        );
      }
    },
    stderr: (eventOpts) => {
      const accepted = stderrLimiter.accept(redactCredential(eventOpts.text));
      if (accepted.text.length > 0) {
        appendStderrPreview(accepted.text);
        if (stderrLooksWarningLike(accepted.text)) {
          emitStderrDiagnosticWarning('stderr_diagnostic', accepted.text);
        }
        emit({
          type: 'call_stderr_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...context,
          channel: 'stderr',
          text: accepted.text,
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit);
    },
    toolUseDelta: (eventOpts) => {
      const toolUseId =
        eventOpts.toolUseId ??
        (eventOpts.stage === 'started' ||
        activeToolUse === null ||
        (eventOpts.name !== null &&
          activeToolUse.name !== null &&
          eventOpts.name !== activeToolUse.name)
          ? randomUUID()
          : activeToolUse.id);
      activeToolUse = { id: toolUseId, name: eventOpts.name ?? activeToolUse?.name ?? null };
      const accepted = toolDeltaLimiter.accept(redactCredential(eventOpts.inputDelta));
      if (accepted.text.length > 0 || accepted.limit === null) {
        emit({
          type: 'call_tool_use_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...context,
          channel: 'tool',
          toolUseId: activeToolUse.id,
          name: activeToolUse.name,
          inputDelta: accepted.text,
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit);
    },
    toolUseDone: (eventOpts) => {
      const toolUse =
        eventOpts.toolUse.id === null
          ? {
              ...eventOpts.toolUse,
              id:
                activeToolUse !== null &&
                (activeToolUse.name === null || activeToolUse.name === eventOpts.toolUse.name)
                  ? activeToolUse.id
                  : randomUUID(),
            }
          : eventOpts.toolUse;
      if (activeToolUse?.id === toolUse.id) activeToolUse = null;
      // Past the cap the result keeps the tool results it has, and the feed
      // still hears every completion: a call does not go quiet at its 257th.
      const kept = toolUseDoneCount < RUNNER_CALL_TOOL_USE_MAX_ITEMS;
      const bounded = boundRunnerCallToolUse(redactRunnerCallToolUse(toolUse, redactCredential));
      recentToolUses.push(bounded.value);
      if (recentToolUses.length > RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS) recentToolUses.shift();
      toolUseDoneCount += 1;
      if (!kept) noteLimit(runnerCallToolUseCountLimit());
      if (bounded.limit !== null) noteLimit(bounded.limit);
      emit(
        {
          type: 'call_tool_use_done',
          ts: eventOpts.ts ?? Date.now(),
          ...context,
          channel: 'tool',
          toolUse: bounded.value,
        },
        kept,
      );
      stopAtToolUseLimit();
    },
    usage: (eventOpts) =>
      emit({
        type: 'call_usage',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        usage: eventOpts.usage,
        semantics: eventOpts.semantics,
      }),
    sessionId: (eventOpts) => {
      // A native session id has cardinality one per call, but stream protocols
      // stamp it on every frame: without this guard one call restates the same
      // id hundreds of times and every consumer treats each as news. Only some
      // frames name the model, so a frame without one keeps the model recorded.
      const newModel =
        eventOpts.resolvedModel !== undefined && eventOpts.resolvedModel !== lastResolvedModel;
      if (eventOpts.nativeSessionId === lastNativeSessionId && !newModel) return;
      lastNativeSessionId = eventOpts.nativeSessionId;
      lastResolvedModel = eventOpts.resolvedModel;
      emit({
        type: 'call_session_id',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        nativeSessionId: eventOpts.nativeSessionId,
        ...(eventOpts.resolvedModel !== undefined && { resolvedModel: eventOpts.resolvedModel }),
      });
    },
    artifact: (eventOpts) => {
      if (artifactCount >= RUNNER_CALL_ARTIFACT_MAX_ITEMS) {
        noteLimit(
          runnerCallItemLimit({
            code: 'runner_call_artifact_count_limit',
            label: 'artifacts',
            maxItems: RUNNER_CALL_ARTIFACT_MAX_ITEMS,
          }),
        );
        return;
      }
      const artifact = {
        ...eventOpts.artifact,
        id: redactCredential(eventOpts.artifact.id),
        name: redactCredential(eventOpts.artifact.name),
        path: eventOpts.artifact.path === null ? null : redactCredential(eventOpts.artifact.path),
        mimeType:
          eventOpts.artifact.mimeType === null
            ? null
            : redactCredential(eventOpts.artifact.mimeType),
        text: eventOpts.artifact.text === null ? null : redactCredential(eventOpts.artifact.text),
      };
      const bounded = boundRunnerCallArtifact(artifact);
      artifactCount += 1;
      if (bounded.limit !== null) noteLimit(bounded.limit);
      const artifactEvent: RunnerCallEventInput = {
        type: 'call_artifact',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        artifact,
      };
      emit(artifactEvent, true, { ...artifactEvent, artifact: bounded.value });
    },
    warning: (eventOpts) => {
      if (warningCount >= RUNNER_CALL_WARNING_MAX_ITEMS) {
        noteLimit(
          runnerCallItemLimit({
            code: 'runner_call_warning_count_limit',
            label: 'warnings',
            maxItems: RUNNER_CALL_WARNING_MAX_ITEMS,
          }),
        );
        return;
      }
      const warning = normalizeRunnerCallWarning(
        redactRunnerCallWarningInput(eventOpts.warning, redactCredential),
      );
      warningCount += 1;
      if (warning.source === 'stderr') stderrWarningEmitted = true;
      emit({
        type: 'call_warning',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        warning,
      });
    },
    unknownUpstream: (eventOpts) => {
      if (unknownUpstreamCount >= RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS) {
        noteLimit(
          runnerCallItemLimit({
            code: 'runner_call_unknown_upstream_count_limit',
            label: 'unknown tool records',
            maxItems: RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
          }),
        );
        return;
      }
      unknownUpstreamCount += 1;
      const rawPreview = sanitizeRunnerCallRawPreview(redactCredential(eventOpts.rawPreview));
      emit({
        type: 'call_unknown_upstream',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        rawPreview,
        backendMetadata: eventOpts.backendMetadata,
      });
    },
    runtimeStatus: (runtimeStatus) => {
      emit({ type: 'call_runtime_status', ts: Date.now(), ...context, runtimeStatus });
    },
    stalled: (eventOpts) => {
      emit({
        type: 'call_stalled',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
        silentMs: eventOpts.silentMs,
      });
    },
    stallCleared: (eventOpts) =>
      emit({
        type: 'call_stall_cleared',
        ts: eventOpts?.ts ?? Date.now(),
        ...context,
      }),
    // Only the feed needs a heartbeat; the result has nothing to keep from one. Claude Code sends
    // its bookkeeping frames in bursts, and the freshness clock counts whole seconds, so one
    // heartbeat a second tells the feed all that a burst can.
    heartbeat: (eventOpts) => {
      const ts = eventOpts?.ts ?? Date.now();
      if (lastHeartbeatTs !== null && ts - lastHeartbeatTs < RUNNER_CALL_HEARTBEAT_INTERVAL_MS) {
        return;
      }
      lastHeartbeatTs = ts;
      emit({ type: 'call_heartbeat', ts, ...context }, false);
    },
    finishCompleted,
    finishFailed,
    finishIncomplete,
    finalResult: () => (hasTerminalEvent ? snapshot() : finishIncomplete()),
    snapshot,
  };
}
