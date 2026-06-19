import { collectRunnerCallResult } from './collector.js';
import {
  isRunnerCallTerminalEvent,
  runnerCallCompletedEvent,
  runnerCallErrorEvent,
} from './status.js';
import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallResult,
  RunnerCallUsage,
  RunnerCallUsageSemantics,
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
  warning: (opts: { warning: RunnerCallEventWarning; ts?: number | undefined }) => void;
  unknownUpstream: (opts: {
    rawPreview: string;
    backendMetadata: RunnerCallUnknownUpstreamMetadata;
    ts?: number | undefined;
  }) => void;
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

type RunnerCallEventWarning = Extract<RunnerCallEvent, { type: 'call_warning' }>['warning'];

export function createRunnerCallRecorder(opts: {
  context: RunnerCallContext;
  onEvent?: ((event: RunnerCallEvent) => void) | undefined;
  startedAt?: number | undefined;
}): RunnerCallRecorder {
  const startedAt = opts.startedAt ?? Date.now();
  const events: RunnerCallEvent[] = [];
  let hasTerminalEvent = false;

  function emit(event: RunnerCallEvent): void {
    if (isRunnerCallTerminalEvent(event)) {
      if (hasTerminalEvent) return;
      hasTerminalEvent = true;
    }
    events.push(event);
    opts.onEvent?.(event);
  }

  function snapshot(): RunnerCallResult {
    return collectRunnerCallResult(events);
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
    emit(
      runnerCallErrorEvent(opts.context, {
        startedAt,
        endedAt: finishOpts.endedAt ?? Date.now(),
        status: finishOpts.status,
        error: finishOpts.error,
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

  emit({ type: 'call_started', ts: startedAt, ...opts.context });

  return {
    context: opts.context,
    startedAt,
    hasTerminal: () => hasTerminalEvent,
    text: (eventOpts) =>
      emit({
        type: 'call_text_delta',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        channel: eventOpts.channel,
        text: eventOpts.text,
        ...(eventOpts.semantics !== undefined && { semantics: eventOpts.semantics }),
      }),
    stderr: (eventOpts) =>
      emit({
        type: 'call_stderr_delta',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        channel: 'stderr',
        text: eventOpts.text,
      }),
    toolUseDelta: (eventOpts) =>
      emit({
        type: 'call_tool_use_delta',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        channel: 'tool',
        toolUseId: eventOpts.toolUseId,
        name: eventOpts.name,
        inputDelta: eventOpts.inputDelta,
      }),
    toolUseDone: (eventOpts) =>
      emit({
        type: 'call_tool_use_done',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        channel: 'tool',
        toolUse: eventOpts.toolUse,
      }),
    usage: (eventOpts) =>
      emit({
        type: 'call_usage',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        usage: eventOpts.usage,
        semantics: eventOpts.semantics,
      }),
    sessionId: (eventOpts) =>
      emit({
        type: 'call_session_id',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        nativeSessionId: eventOpts.nativeSessionId,
      }),
    artifact: (eventOpts) =>
      emit({
        type: 'call_artifact',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        artifact: eventOpts.artifact,
      }),
    warning: (eventOpts) =>
      emit({
        type: 'call_warning',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        warning: eventOpts.warning,
      }),
    unknownUpstream: (eventOpts) =>
      emit({
        type: 'call_unknown_upstream',
        ts: eventOpts.ts ?? Date.now(),
        ...opts.context,
        rawPreview: eventOpts.rawPreview,
        backendMetadata: eventOpts.backendMetadata,
      }),
    finishCompleted,
    finishFailed,
    finishIncomplete,
    finalResult: () => (hasTerminalEvent ? snapshot() : finishIncomplete()),
    snapshot,
  };
}

function hasPartialResult(result: RunnerCallResult): boolean {
  return (
    result.text.length > 0 ||
    result.warnings.length > 0 ||
    result.toolUses.length > 0 ||
    result.artifacts.length > 0
  );
}
