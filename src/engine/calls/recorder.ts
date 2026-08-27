import { collectRunnerCallResult } from './collector.js';
import { RunnerCallEventSchema, RunnerCallResultSchema } from './schema.js';
import {
  boundedRunnerCallMessage,
  createRunnerCallCredentialRedactor,
  isRunnerCallTerminalEvent,
  runnerCallCompletedEvent,
  runnerCallErrorEvent,
} from './status.js';
import { error } from '../../utils/error.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';
import { isRecord } from '../../utils/type-guards.js';
import { formatZodIssues, runnerCallUnknownUpstreamPreview } from './unknown-upstream.js';
import {
  boundRunnerCallArtifact,
  boundRunnerCallToolUse,
  createRunnerCallDeltaLimiter,
  createRunnerCallEnvelopeLimiter,
  runnerCallLimitWarning,
  sanitizeRunnerCallRawPreview,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
  RUNNER_CALL_WARNING_MAX_ITEMS,
  type RunnerCallOutputLimit,
} from './output-limit.js';
import { normalizeRunnerCallWarning } from './warnings.js';
import {
  redactRunnerCallEventInput,
  redactRunnerCallToolUse,
  redactRunnerCallWarningInput,
  type RunnerCallToolUse,
} from './redact-event.js';
import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallEventInput,
  RunnerCallFailureStatus,
  RunnerCallResult,
  RunnerCallUsage,
  RunnerCallUsageSemantics,
  RunnerCallWarningInput,
} from './types.js';

type RunnerCallTextChannel = Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'];
type RunnerCallArtifact = Extract<RunnerCallEvent, { type: 'call_artifact' }>['artifact'];
type RunnerCallUnknownUpstreamMetadata = Extract<
  RunnerCallEvent,
  { type: 'call_unknown_upstream' }
>['backendMetadata'];

export interface RunnerCallRecorder {
  readonly context: RunnerCallContext;
  readonly startedAt: number;
  hasTerminal: () => boolean;
  text: (opts: {
    channel: RunnerCallTextChannel;
    text: string;
    semantics?: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['semantics'];
    ts?: number | undefined;
  }) => void;
  stderr: (opts: { text: string; ts?: number | undefined }) => void;
  toolUseDelta: (opts: {
    toolUseId: string | null;
    name: string | null;
    inputDelta: string;
    ts?: number | undefined;
  }) => void;
  toolUseDone: (opts: { toolUse: RunnerCallToolUse; ts?: number | undefined }) => void;
  usage: (opts: {
    usage: RunnerCallUsage;
    semantics: RunnerCallUsageSemantics;
    ts?: number | undefined;
  }) => void;
  sessionId: (opts: { nativeSessionId: string; ts?: number | undefined }) => void;
  artifact: (opts: { artifact: RunnerCallArtifact; ts?: number | undefined }) => void;
  warning: (opts: { warning: RunnerCallWarningInput; ts?: number | undefined }) => void;
  unknownUpstream: (opts: {
    rawPreview: string;
    backendMetadata: RunnerCallUnknownUpstreamMetadata;
    ts?: number | undefined;
  }) => void;
  stalled: (opts: { silentMs: number; ts?: number | undefined }) => void;
  stallCleared: (opts?: { ts?: number | undefined }) => void;
  finishCompleted: (opts?: {
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
    endedAt?: number | undefined;
  }) => RunnerCallResult;
  finishFailed: (opts: {
    status: RunnerCallFailureStatus;
    error: RunnerCallError;
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
    partial?: boolean | undefined;
    endedAt?: number | undefined;
  }) => RunnerCallResult;
  finishIncomplete: (opts?: { endedAt?: number | undefined }) => RunnerCallResult;
  finalResult: () => RunnerCallResult;
  snapshot: () => RunnerCallResult;
}

export function createRunnerCallRecorder(opts: {
  context: RunnerCallContext;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  startedAt?: number | undefined;
  credentialValues?: readonly string[] | undefined;
}): RunnerCallRecorder {
  const startedAt = opts.startedAt ?? Date.now();
  const redactCredential = createRunnerCallCredentialRedactor(opts.credentialValues ?? []);
  const events: RunnerCallEvent[] = [];
  let hasTerminalEvent = false;
  let resultLimit: RunnerCallOutputLimit | null = null;
  let toolUseDoneCount = 0;
  let artifactCount = 0;
  let warningCount = 0;
  let unknownUpstreamCount = 0;
  let stderrPreview = '';
  let stderrWarningEmitted = false;
  let lastNativeSessionId: string | null = null;
  const emittedLimitWarnings = new Set<string>();
  let textLimiter = createTextLimiter();
  const envelopeLimiter =
    opts.context.envelope === undefined
      ? null
      : createRunnerCallEnvelopeLimiter({ envelope: opts.context.envelope, startedAt });
  let draftTextBytes = 0;
  const stderrLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_stderr_limit',
    label: 'runner call stderr diagnostics',
    maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
  });
  const toolDeltaLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_tool_delta_limit',
    label: 'runner call tool deltas',
  });

  function emit(input: RunnerCallEventInput): void {
    const event = validateRunnerCallEvent(redactRunnerCallEventInput(input, redactCredential));
    if (hasTerminalEvent && !isRunnerCallTerminalEvent(event)) return;
    if (isRunnerCallTerminalEvent(event)) {
      if (hasTerminalEvent) return;
      hasTerminalEvent = true;
    }
    events.push(event);
    opts.onEvent?.(event);
  }

  function snapshot(): RunnerCallResult {
    return validateRunnerCallResult(collectRunnerCallResult(events));
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
    } = {},
  ): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    const defaults = currentTerminalDefaults(finishOpts);
    if (envelopeLimiter !== null) {
      envelopeLimiter.checkDeadline(finishOpts.endedAt ?? Date.now());
      noteEnvelopeLatch();
    }
    if (resultLimit !== null) {
      return finishFailed({
        status: 'truncated',
        error: { code: resultLimit.code, message: resultLimit.message },
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        partial: true,
        endedAt: finishOpts.endedAt,
      });
    }
    emit(
      runnerCallCompletedEvent(opts.context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
      }),
    );
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
    const callError = {
      code: redactCredential(finishOpts.error.code),
      message: boundedRunnerCallMessage(finishOpts.error.message, opts.credentialValues),
    };
    emitStderrFailureWarning();
    emit(
      runnerCallErrorEvent(opts.context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        status: finishOpts.status,
        error: callError,
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        partial: finishOpts.partial ?? defaults.partial,
      }),
    );
    return snapshot();
  }

  function finishIncomplete(finishOpts: { endedAt?: number | undefined } = {}): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    if (envelopeLimiter !== null) {
      envelopeLimiter.checkDeadline(finishOpts.endedAt ?? Date.now());
      noteEnvelopeLatch();
    }
    if (resultLimit !== null) {
      return finishFailed({
        status: 'truncated',
        error: { code: resultLimit.code, message: resultLimit.message },
        partial: true,
        endedAt: finishOpts.endedAt,
      });
    }
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
      callId: opts.context.callId,
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
      ...opts.context,
      rawPreview: runnerCallUnknownUpstreamPreview({
        label: 'Invalid runner call event',
        value: input,
        issues,
      }),
      backendMetadata: {
        backendKind: opts.context.backendKind,
        source: 'recorder',
        ...(upstreamType !== undefined && { upstreamType }),
      },
    };
  }

  emit({ type: 'call_started', ts: startedAt, ...opts.context });

  function noteLimit(
    limit: RunnerCallOutputLimit,
    disposition: 'truncates-result' | 'diagnostic-only',
  ): void {
    if (disposition === 'truncates-result' && resultLimit === null) resultLimit = limit;
    if (emittedLimitWarnings.has(limit.code)) return;
    emittedLimitWarnings.add(limit.code);
    emit({
      type: 'call_warning',
      ts: Date.now(),
      ...opts.context,
      warning: runnerCallLimitWarning(limit),
    });
  }

  function noteEnvelopeLatch(): void {
    if (envelopeLimiter === null) return;
    const limit = envelopeLimiter.limit;
    if (limit !== null) noteLimit(limit, 'truncates-result');
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
      ...opts.context,
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
    context: opts.context,
    startedAt,
    hasTerminal: () => hasTerminalEvent,
    text: (eventOpts) => {
      if (eventOpts.semantics === 'final') textLimiter = createTextLimiter();
      const accepted = textLimiter.accept(redactCredential(eventOpts.text));
      const eventText = accepted.text;
      if (accepted.limit === null && resultLimit?.code === 'runner_call_text_limit') {
        resultLimit = null;
      }
      if (envelopeLimiter !== null) {
        const bytes = Buffer.byteLength(eventOpts.text, 'utf8');
        envelopeLimiter.recordRaw(bytes);
        envelopeLimiter.recordNormalized(
          eventOpts.semantics === 'final' ? bytes - draftTextBytes : bytes,
        );
        if (eventOpts.semantics === 'final') draftTextBytes = 0;
        else draftTextBytes += bytes;
        envelopeLimiter.checkDeadline(eventOpts.ts ?? Date.now());
        noteEnvelopeLatch();
      }
      if (eventText.length > 0 || (eventOpts.semantics === 'final' && accepted.limit === null)) {
        emit({
          type: 'call_text_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...opts.context,
          channel: eventOpts.channel,
          text: eventText,
          ...(eventOpts.semantics !== undefined && { semantics: eventOpts.semantics }),
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit, 'truncates-result');
    },
    stderr: (eventOpts) => {
      const accepted = stderrLimiter.accept(redactCredential(eventOpts.text));
      if (envelopeLimiter !== null) {
        const bytes = Buffer.byteLength(eventOpts.text, 'utf8');
        envelopeLimiter.recordStderr(bytes);
        envelopeLimiter.recordRaw(bytes);
        envelopeLimiter.checkDeadline(eventOpts.ts ?? Date.now());
        noteEnvelopeLatch();
      }
      if (accepted.text.length > 0) {
        appendStderrPreview(accepted.text);
        if (stderrLooksWarningLike(accepted.text)) {
          emitStderrDiagnosticWarning('stderr_diagnostic', accepted.text);
        }
        emit({
          type: 'call_stderr_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...opts.context,
          channel: 'stderr',
          text: accepted.text,
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit, 'diagnostic-only');
    },
    toolUseDelta: (eventOpts) => {
      const accepted = toolDeltaLimiter.accept(redactCredential(eventOpts.inputDelta), {
        countEvent: true,
      });
      if (envelopeLimiter !== null) {
        envelopeLimiter.recordRaw(Buffer.byteLength(eventOpts.inputDelta, 'utf8'));
        envelopeLimiter.checkDeadline(eventOpts.ts ?? Date.now());
        noteEnvelopeLatch();
      }
      if (accepted.text.length > 0 || accepted.limit === null) {
        emit({
          type: 'call_tool_use_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...opts.context,
          channel: 'tool',
          toolUseId: eventOpts.toolUseId,
          name: eventOpts.name,
          inputDelta: accepted.text,
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit, 'truncates-result');
    },
    toolUseDone: (eventOpts) => {
      if (toolUseDoneCount >= RUNNER_CALL_TOOL_USE_MAX_ITEMS) {
        noteLimit(
          itemLimit({
            code: 'runner_call_tool_use_count_limit',
            label: 'runner call tool results',
            maxItems: RUNNER_CALL_TOOL_USE_MAX_ITEMS,
            nextItemCount: toolUseDoneCount + 1,
          }),
          'truncates-result',
        );
        return;
      }
      const bounded = boundRunnerCallToolUse(
        redactRunnerCallToolUse(eventOpts.toolUse, redactCredential),
      );
      toolUseDoneCount += 1;
      if (bounded.limit !== null) noteLimit(bounded.limit, 'truncates-result');
      if (envelopeLimiter !== null) {
        envelopeLimiter.recordRaw(Buffer.byteLength(JSON.stringify(bounded.value), 'utf8'));
        noteEnvelopeLatch();
      }
      emit({
        type: 'call_tool_use_done',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        channel: 'tool',
        toolUse: bounded.value,
      });
    },
    usage: (eventOpts) =>
      emit({
        type: 'call_usage',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        usage: eventOpts.usage,
        semantics: eventOpts.semantics,
      }),
    sessionId: (eventOpts) => {
      // A native session id has cardinality one per call, but stream protocols
      // stamp it on every frame: without this guard one call restates the same
      // id hundreds of times and every consumer treats each as news.
      if (eventOpts.nativeSessionId === lastNativeSessionId) return;
      lastNativeSessionId = eventOpts.nativeSessionId;
      emit({
        type: 'call_session_id',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        nativeSessionId: eventOpts.nativeSessionId,
      });
    },
    artifact: (eventOpts) => {
      if (artifactCount >= RUNNER_CALL_ARTIFACT_MAX_ITEMS) {
        noteLimit(
          itemLimit({
            code: 'runner_call_artifact_count_limit',
            label: 'runner call artifacts',
            maxItems: RUNNER_CALL_ARTIFACT_MAX_ITEMS,
            nextItemCount: artifactCount + 1,
          }),
          'truncates-result',
        );
        return;
      }
      const bounded = boundRunnerCallArtifact({
        ...eventOpts.artifact,
        id: redactCredential(eventOpts.artifact.id),
        name: redactCredential(eventOpts.artifact.name),
        path: eventOpts.artifact.path === null ? null : redactCredential(eventOpts.artifact.path),
        mimeType:
          eventOpts.artifact.mimeType === null
            ? null
            : redactCredential(eventOpts.artifact.mimeType),
        text: eventOpts.artifact.text === null ? null : redactCredential(eventOpts.artifact.text),
      });
      artifactCount += 1;
      if (bounded.limit !== null) noteLimit(bounded.limit, 'truncates-result');
      if (envelopeLimiter !== null && bounded.value.text !== null) {
        envelopeLimiter.recordRaw(Buffer.byteLength(bounded.value.text, 'utf8'));
        noteEnvelopeLatch();
      }
      emit({
        type: 'call_artifact',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        artifact: bounded.value,
      });
    },
    warning: (eventOpts) => {
      if (warningCount >= RUNNER_CALL_WARNING_MAX_ITEMS) {
        noteLimit(
          itemLimit({
            code: 'runner_call_warning_count_limit',
            label: 'runner call warnings',
            maxItems: RUNNER_CALL_WARNING_MAX_ITEMS,
            nextItemCount: warningCount + 1,
          }),
          'diagnostic-only',
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
        ...opts.context,
        warning,
      });
    },
    unknownUpstream: (eventOpts) => {
      if (unknownUpstreamCount >= RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS) {
        noteLimit(
          itemLimit({
            code: 'runner_call_unknown_upstream_count_limit',
            label: 'runner call unknown upstream diagnostics',
            maxItems: RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
            nextItemCount: unknownUpstreamCount + 1,
          }),
          'diagnostic-only',
        );
        return;
      }
      unknownUpstreamCount += 1;
      const rawPreview = sanitizeRunnerCallRawPreview(redactCredential(eventOpts.rawPreview));
      if (envelopeLimiter !== null) {
        envelopeLimiter.recordRaw(Buffer.byteLength(rawPreview, 'utf8'));
        noteEnvelopeLatch();
      }
      emit({
        type: 'call_unknown_upstream',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        rawPreview,
        backendMetadata: eventOpts.backendMetadata,
      });
    },
    stalled: (eventOpts) => {
      if (envelopeLimiter !== null) {
        envelopeLimiter.checkIdle(eventOpts.silentMs);
        noteEnvelopeLatch();
      }
      emit({
        type: 'call_stalled',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        silentMs: eventOpts.silentMs,
      });
    },
    stallCleared: (eventOpts) =>
      emit({
        type: 'call_stall_cleared',
        ts: eventOpts?.ts ?? Date.now(),
        ...opts.context,
      }),
    finishCompleted,
    finishFailed,
    finishIncomplete,
    finalResult: () => (hasTerminalEvent ? snapshot() : finishIncomplete()),
    snapshot,
  };
}

function nowOrTimestamp(input: RunnerCallEventInput): number {
  if (
    isRecord(input) &&
    typeof input.ts === 'number' &&
    Number.isInteger(input.ts) &&
    input.ts >= 0
  ) {
    return input.ts;
  }
  return Date.now();
}

function recordType(input: RunnerCallEventInput): unknown {
  return isRecord(input) ? input.type : undefined;
}

function metadataString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = sanitizeTerminalDiagnosticText(value, { maxChars: 256 }).trim();
  return clean.length > 0 ? clean : undefined;
}

function createTextLimiter(): ReturnType<typeof createRunnerCallDeltaLimiter> {
  return createRunnerCallDeltaLimiter({
    code: 'runner_call_text_limit',
    label: 'runner call text',
  });
}

function hasPartialResult(result: RunnerCallResult): boolean {
  return (
    result.text.length > 0 ||
    result.warnings.length > 0 ||
    result.toolUses.length > 0 ||
    result.artifacts.length > 0
  );
}
