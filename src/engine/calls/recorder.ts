import { collectRunnerCallResult } from './collector.js';
import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../core/schemas/invocation-identity.js';
import {
  RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH,
  RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
  RunnerCallEventSchema,
  RunnerCallResultSchema,
} from './schema.js';
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
  runnerCallLimitWarning,
  runnerCallToolUseCountLimit,
  sanitizeRunnerCallRawPreview,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS,
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

const RUNNER_CALL_HEARTBEAT_INTERVAL_MS = 1_000;

export interface RunnerCallRecorder {
  readonly context: RunnerCallContext;
  readonly startedAt: number;
  hasTerminal: () => boolean;
  runtimeStatus: (
    status: Extract<RunnerCallEvent, { type: 'call_runtime_status' }>['runtimeStatus'],
  ) => void;
  text: (opts: {
    channel: RunnerCallTextChannel;
    text: string;
    subagentId?: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['subagentId'];
    semantics?: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['semantics'];
    ts?: number | undefined;
  }) => void;
  stderr: (opts: { text: string; ts?: number | undefined }) => void;
  toolUseDelta: (opts: {
    toolUseId: string | null;
    name: string | null;
    inputDelta: string;
    /**
     * `started` replays the input a tool was announced with, which `toolUseDone` carries again in
     * full, so a flood of starts is diagnostic like a done event. Only the streamed `delta` stage
     * is the result's own text, so only it truncates the call.
     */
    stage?: 'started' | 'delta' | undefined;
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
  heartbeat: (opts?: { ts?: number | undefined }) => void;
  finishCompleted: (opts?: {
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
    endedAt?: number | undefined;
    structured?: unknown;
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
  onLimit?: (() => void) | undefined;
  startedAt?: number | undefined;
  credentialValues?: readonly string[] | undefined;
}): RunnerCallRecorder {
  const context = snapshotRunnerCallContext(opts.context);
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
  let lastHeartbeatTs: number | null = null;
  const recentToolUses: RunnerCallToolUse[] = [];
  let toolUseLimitExceeded = false;
  const emittedLimitWarnings = new Set<string>();
  let textLimiter = createTextLimiter();
  const subagentTextLimiter = createTextLimiter();
  const stderrLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_stderr_limit',
    label: 'runner call stderr diagnostics',
    maxBytes: RUNNER_CALL_STDERR_MAX_BYTES,
  });
  const toolDeltaLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_call_tool_delta_limit',
    label: 'runner call tool deltas',
  });

  /** An event the result does not keep still reaches the feed. */
  function emit(input: RunnerCallEventInput, retain = true): void {
    const event = validateRunnerCallEvent(redactRunnerCallEventInput(input, redactCredential));
    if (hasTerminalEvent && !isRunnerCallTerminalEvent(event)) return;
    if (isRunnerCallTerminalEvent(event)) {
      if (hasTerminalEvent) return;
      hasTerminalEvent = true;
    }
    if (retain) events.push(event);
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
      structured?: unknown;
    } = {},
  ): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    const defaults = currentTerminalDefaults(finishOpts);
    if (finishOpts.structured !== undefined) {
      const structuredBytes = Buffer.byteLength(JSON.stringify(finishOpts.structured), 'utf8');
      if (structuredBytes > RUNNER_CALL_OUTPUT_MAX_BYTES) {
        noteLimit(
          {
            code: 'runner_call_structured_limit',
            message: `runner call structured answer exceeded ${RUNNER_CALL_OUTPUT_MAX_BYTES} bytes`,
            bytesSeen: structuredBytes,
            maxBytes: RUNNER_CALL_OUTPUT_MAX_BYTES,
          },
          'truncates-result',
        );
      }
    }
    if (toolUseLimitExceeded) resultLimit = runnerCallToolUseCountLimit(recentToolUses);
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
      runnerCallCompletedEvent(context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        ...(finishOpts.structured !== undefined && { structured: finishOpts.structured }),
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
    const toolUseLimit = toolUseLimitExceeded ? runnerCallToolUseCountLimit(recentToolUses) : null;
    const providerType =
      finishOpts.error.providerType === undefined
        ? undefined
        : boundedRunnerCallProviderType(redactCredential(finishOpts.error.providerType));
    const callError =
      toolUseLimit === null
        ? {
            code: redactCredential(finishOpts.error.code),
            message: boundedRunnerCallMessage(finishOpts.error.message, opts.credentialValues),
            ...(finishOpts.error.status !== undefined && { status: finishOpts.error.status }),
            ...(providerType !== undefined && { providerType }),
          }
        : {
            code: toolUseLimit.code,
            message: boundedRunnerCallMessage(toolUseLimit.message, opts.credentialValues),
          };
    const rawTail = runnerCallRawTail(callError.message, opts.credentialValues);
    // Judged on the text the call ends with: a final text that fits replaced
    // whatever the budget cut from the narration streamed before it.
    if (toolUseLimit === null && textLimiter.limit !== null) {
      noteLimit(textLimiter.limit, 'truncates-result');
    }
    emitStderrFailureWarning();
    emit(
      runnerCallErrorEvent(context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        status: toolUseLimit === null ? finishOpts.status : 'truncated',
        error: callError,
        usage: defaults.usage,
        nativeSessionId: defaults.nativeSessionId,
        partial: toolUseLimit === null ? (finishOpts.partial ?? defaults.partial) : true,
        ...(rawTail !== undefined && { rawTail }),
      }),
    );
    return snapshot();
  }

  function finishIncomplete(finishOpts: { endedAt?: number | undefined } = {}): RunnerCallResult {
    if (hasTerminalEvent) return snapshot();
    if (toolUseLimitExceeded) resultLimit = runnerCallToolUseCountLimit(recentToolUses);
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
      ...context,
      warning: runnerCallLimitWarning(limit),
    });
  }

  function noteToolUseCountExceeded(): void {
    const limit = runnerCallToolUseCountLimit(recentToolUses);
    if (!emittedLimitWarnings.has(limit.code)) {
      emittedLimitWarnings.add(limit.code);
      emit({
        type: 'call_warning',
        ts: Date.now(),
        ...context,
        warning: runnerCallLimitWarning(limit),
      });
    }
    if (context.role !== 'implementer' || toolUseLimitExceeded) return;
    toolUseLimitExceeded = true;
    opts.onLimit?.();
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
      // An explicit `delta` is a partial slice of one record: the byte budget
      // bounds it, the event budget counts records.
      const accepted = (isSubagent ? subagentTextLimiter : textLimiter).accept(
        redactCredential(eventOpts.text),
      );
      const eventText = accepted.text;
      if (
        !isSubagent &&
        accepted.limit === null &&
        resultLimit?.code === 'runner_call_text_limit'
      ) {
        resultLimit = null;
      }
      if (eventText.length > 0 || (eventOpts.semantics === 'final' && accepted.limit === null)) {
        emit({
          type: 'call_text_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...context,
          channel: eventOpts.channel,
          text: eventText,
          ...(eventOpts.subagentId !== undefined && { subagentId: eventOpts.subagentId }),
          ...(eventOpts.semantics !== undefined && { semantics: eventOpts.semantics }),
        });
      }
      if (accepted.limit !== null) {
        if (isSubagent) noteLimit(accepted.limit, 'diagnostic-only');
        else if (resultLimit === null) resultLimit = accepted.limit;
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
      if (accepted.limit !== null) noteLimit(accepted.limit, 'diagnostic-only');
    },
    toolUseDelta: (eventOpts) => {
      const accepted = toolDeltaLimiter.accept(redactCredential(eventOpts.inputDelta));
      if (accepted.text.length > 0 || accepted.limit === null) {
        emit({
          type: 'call_tool_use_delta',
          ts: eventOpts.ts ?? Date.now(),
          ...context,
          channel: 'tool',
          toolUseId: eventOpts.toolUseId,
          name: eventOpts.name,
          inputDelta: accepted.text,
        });
      }
      if (accepted.limit !== null) {
        noteLimit(
          accepted.limit,
          eventOpts.stage === 'started' ? 'diagnostic-only' : 'truncates-result',
        );
      }
    },
    toolUseDone: (eventOpts) => {
      // Past the cap the result keeps the tool results it has, and the feed
      // still hears every completion: a call does not go quiet at its 257th.
      const kept = toolUseDoneCount < RUNNER_CALL_TOOL_USE_MAX_ITEMS;
      const bounded = boundRunnerCallToolUse(
        redactRunnerCallToolUse(eventOpts.toolUse, redactCredential),
      );
      recentToolUses.push(bounded.value);
      if (recentToolUses.length > RUNNER_CALL_TOOL_USE_SUMMARY_MAX_ITEMS) recentToolUses.shift();
      toolUseDoneCount += 1;
      if (!kept) noteToolUseCountExceeded();
      if (bounded.limit !== null) noteLimit(bounded.limit, 'diagnostic-only');
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
      // id hundreds of times and every consumer treats each as news.
      if (eventOpts.nativeSessionId === lastNativeSessionId) return;
      lastNativeSessionId = eventOpts.nativeSessionId;
      emit({
        type: 'call_session_id',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
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
      emit({
        type: 'call_artifact',
        ts: eventOpts.ts ?? Date.now(),
        ...context,
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
        ...context,
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

// The identity is fixed before `call_started`: every event and result of the
// call carries this one frozen copy, whatever the producer does with its own.
function snapshotRunnerCallContext(context: RunnerCallContext): RunnerCallContext {
  context = {
    ...context,
    ...(context.axes !== undefined && { axes: Object.freeze([...context.axes]) }),
  };
  if (context.invocationIdentity === undefined) return context;
  const parsed = InvocationIdentitySchema.safeParse(context.invocationIdentity);
  if (!parsed.success) {
    throw error('runner-call-identity-invalid', 'Runner call invocation identity is invalid', {
      callId: context.callId,
      issues: formatZodIssues(parsed.error.issues),
    });
  }
  return { ...context, invocationIdentity: freezeInvocationIdentity(parsed.data) };
}

function freezeInvocationIdentity(identity: InvocationIdentity): InvocationIdentity {
  for (const value of Object.values(identity)) {
    if (typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(identity);
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

function boundedRunnerCallProviderType(value: string): string {
  return value.length <= RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH
    ? value
    : value.slice(0, RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH);
}

function runnerCallRawTail(
  message: string,
  credentialValues: readonly string[] = [],
): string | undefined {
  const firstLine = message.split('\n', 1)[0] ?? '';
  const redacted = createRunnerCallCredentialRedactor(credentialValues)(firstLine);
  const clean = sanitizeTerminalDiagnosticText(redacted, {
    maxChars: RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
  }).trim();
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
