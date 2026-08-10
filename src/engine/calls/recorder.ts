import { collectRunnerCallResult } from './collector.js';
import { RunnerCallEventSchema, RunnerCallResultSchema } from './schema.js';
import {
  boundedRunnerCallMessage,
  createRunnerCallCredentialRedactor,
  isRunnerCallTerminalEvent,
  runnerCallCompletedEvent,
  runnerCallErrorEvent,
  type RunnerCallCredentialRedactor,
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
  sanitizeRunnerCallRawPreview,
  RUNNER_CALL_ARTIFACT_MAX_ITEMS,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS,
  RUNNER_CALL_WARNING_MAX_ITEMS,
  type RunnerCallOutputLimit,
} from './output-limit.js';
import { normalizeRunnerCallWarning } from './warnings.js';
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
type RunnerCallToolUse = Extract<RunnerCallEvent, { type: 'call_tool_use_done' }>['toolUse'];
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

  function noteLimit(limit: RunnerCallOutputLimit, resultIncomplete: boolean): void {
    if (resultIncomplete && resultLimit === null) resultLimit = limit;
    if (emittedLimitWarnings.has(limit.code)) return;
    emittedLimitWarnings.add(limit.code);
    emit({
      type: 'call_warning',
      ts: Date.now(),
      ...opts.context,
      warning: runnerCallLimitWarning(limit),
    });
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
      if (accepted.limit !== null) noteLimit(accepted.limit, true);
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
          ...opts.context,
          channel: 'stderr',
          text: accepted.text,
        });
      }
      if (accepted.limit !== null) noteLimit(accepted.limit, false);
    },
    toolUseDelta: (eventOpts) => {
      const accepted = toolDeltaLimiter.accept(redactCredential(eventOpts.inputDelta), {
        countEvent: true,
      });
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
      if (accepted.limit !== null) noteLimit(accepted.limit, true);
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
          true,
        );
        return;
      }
      const bounded = boundRunnerCallToolUse(
        redactRunnerCallToolUse(eventOpts.toolUse, redactCredential),
      );
      toolUseDoneCount += 1;
      if (bounded.limit !== null) noteLimit(bounded.limit, true);
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
          true,
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
      if (bounded.limit !== null) noteLimit(bounded.limit, true);
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
          false,
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
          false,
        );
        return;
      }
      unknownUpstreamCount += 1;
      emit({
        type: 'call_unknown_upstream',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        rawPreview: sanitizeRunnerCallRawPreview(redactCredential(eventOpts.rawPreview)),
        backendMetadata: eventOpts.backendMetadata,
      });
    },
    stalled: (eventOpts) =>
      emit({
        type: 'call_stalled',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        silentMs: eventOpts.silentMs,
      }),
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

function redactRunnerCallEventInput(
  input: RunnerCallEventInput,
  redact: RunnerCallCredentialRedactor,
): RunnerCallEventInput {
  switch (input.type) {
    case 'call_text_delta':
    case 'call_stderr_delta':
      return { ...input, text: redact(input.text) };
    case 'call_tool_use_delta':
      return {
        ...input,
        toolUseId: input.toolUseId === null ? null : redact(input.toolUseId),
        name: input.name === null ? null : redact(input.name),
        inputDelta: redact(input.inputDelta),
      };
    case 'call_tool_use_done':
      return { ...input, toolUse: redactRunnerCallToolUse(input.toolUse, redact) };
    case 'call_session_id':
      return { ...input, nativeSessionId: redact(input.nativeSessionId) };
    case 'call_artifact':
      return {
        ...input,
        artifact: {
          ...input.artifact,
          id: redact(input.artifact.id),
          name: redact(input.artifact.name),
          path: input.artifact.path === null ? null : redact(input.artifact.path),
          mimeType: input.artifact.mimeType === null ? null : redact(input.artifact.mimeType),
          text: input.artifact.text === null ? null : redact(input.artifact.text),
        },
      };
    case 'call_warning':
      return { ...input, warning: redactRunnerCallWarningInput(input.warning, redact) };
    case 'call_error':
      return {
        ...input,
        error: {
          code: redact(input.error.code),
          message: redact(input.error.message),
        },
        nativeSessionId: input.nativeSessionId === null ? null : redact(input.nativeSessionId),
      };
    case 'call_completed':
      return {
        ...input,
        nativeSessionId: input.nativeSessionId === null ? null : redact(input.nativeSessionId),
      };
    case 'call_unknown_upstream':
      return {
        ...input,
        rawPreview: redact(input.rawPreview),
        backendMetadata: {
          ...input.backendMetadata,
          ...(input.backendMetadata.source !== undefined && {
            source: redact(input.backendMetadata.source),
          }),
          ...(input.backendMetadata.parser !== undefined && {
            parser: redact(input.backendMetadata.parser),
          }),
          ...(input.backendMetadata.upstreamType !== undefined && {
            upstreamType: redact(input.backendMetadata.upstreamType),
          }),
        },
      };
    case 'call_started':
    case 'call_usage':
    case 'call_stalled':
    case 'call_stall_cleared':
      return input;
  }
}

function redactRunnerCallWarningInput(
  warning: RunnerCallWarningInput,
  redact: RunnerCallCredentialRedactor,
): RunnerCallWarningInput {
  const code = redact(warning.code);
  const message = redact(warning.message);
  const source = warning.source === undefined ? undefined : redact(warning.source);
  const parser = warning.parser === undefined ? undefined : redact(warning.parser);
  const upstreamType =
    warning.upstreamType === undefined ? undefined : redact(warning.upstreamType);
  const fingerprint = warning.fingerprint === undefined ? undefined : redact(warning.fingerprint);
  const rawRef = warning.rawRef === undefined ? undefined : redact(warning.rawRef);
  const wasRedacted =
    code !== warning.code ||
    message !== warning.message ||
    source !== warning.source ||
    parser !== warning.parser ||
    upstreamType !== warning.upstreamType ||
    fingerprint !== warning.fingerprint ||
    rawRef !== warning.rawRef;

  return {
    ...warning,
    code,
    message,
    ...(source !== undefined && { source }),
    ...(parser !== undefined && { parser }),
    ...(upstreamType !== undefined && { upstreamType }),
    ...(fingerprint !== undefined && { fingerprint }),
    ...(rawRef !== undefined && { rawRef }),
    ...(wasRedacted && { redacted: true }),
  };
}

function redactRunnerCallToolUse(
  toolUse: RunnerCallToolUse,
  redact: RunnerCallCredentialRedactor,
): RunnerCallToolUse {
  return {
    id: toolUse.id === null ? null : redact(toolUse.id),
    name: redact(toolUse.name),
    input: redactRunnerCallRecord(toolUse.input, redact),
    ...(toolUse.output !== undefined && {
      output: redactRunnerCallUnknown(toolUse.output, redact, new WeakSet<object>()),
    }),
  };
}

function redactRunnerCallRecord(
  value: Readonly<Record<string, unknown>>,
  redact: RunnerCallCredentialRedactor,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    redacted[redact(key)] = redactRunnerCallUnknown(item, redact, seen);
  }
  return redacted;
}

function redactRunnerCallUnknown(
  value: unknown,
  redact: RunnerCallCredentialRedactor,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactRunnerCallUnknown(item, redact, seen));
    }
    if (!isRecord(value)) return value;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[redact(key)] = redactRunnerCallUnknown(item, redact, seen);
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}
