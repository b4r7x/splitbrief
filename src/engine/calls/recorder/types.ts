import type { RunnerCallArtifact } from '../bounded-payload.js';
import type {
  createRunnerCallDeltaLimiter,
  HeadTailEventLog,
  RunnerCallOutputLimit,
} from '../output-limit.js';
import type { RunnerCallToolUse } from '../redact-event.js';
import type { RunnerCallCredentialRedactor } from '../status.js';
import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallResult,
  RunnerCallUsage,
  RunnerCallUsageSemantics,
  RunnerCallWarningInput,
} from '../types.js';

type RunnerCallTextChannel = Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'];
type RunnerCallUnknownUpstreamMetadata = Extract<
  RunnerCallEvent,
  { type: 'call_unknown_upstream' }
>['backendMetadata'];

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
    /** `started` replays the input a tool was announced with: it starts a new tool use. */
    stage?: 'started' | 'delta' | undefined;
    ts?: number | undefined;
  }) => void;
  toolUseDone: (opts: { toolUse: RunnerCallToolUse; ts?: number | undefined }) => void;
  usage: (opts: {
    usage: RunnerCallUsage;
    semantics: RunnerCallUsageSemantics;
    ts?: number | undefined;
  }) => void;
  sessionId: (opts: {
    nativeSessionId: string;
    /** The model id the tool reports it runs, when it reports one. */
    resolvedModel?: string | undefined;
    ts?: number | undefined;
  }) => void;
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
  finalResult: () => RunnerCallResult;
  snapshot: () => RunnerCallResult;
}

type RunnerCallDeltaLimiter = ReturnType<typeof createRunnerCallDeltaLimiter>;

/** What the steps of one call share, changed in place: each recorder method reads and writes it. */
export interface RunnerCallRecorderState {
  readonly context: RunnerCallContext;
  readonly startedAt: number;
  readonly onEvent: ((event: RunnerCallEvent) => void) | undefined;
  readonly stopAfterToolUses: number | undefined;
  readonly onLimit: (() => void) | undefined;
  readonly credentialValues: readonly string[] | undefined;
  readonly redactCredential: RunnerCallCredentialRedactor;
  readonly events: HeadTailEventLog<RunnerCallEvent>;
  hasTerminalEvent: boolean;
  toolUseDoneCount: number;
  artifactCount: number;
  warningCount: number;
  unknownUpstreamCount: number;
  stderrPreview: string;
  stderrWarningEmitted: boolean;
  lastNativeSessionId: string | null;
  lastResolvedModel: string | undefined;
  lastHeartbeatTs: number | null;
  activeToolUse: { id: string; name: string | null } | null;
  readonly recentToolUses: RunnerCallToolUse[];
  toolUseStop: RunnerCallOutputLimit | null;
  readonly emittedLimitWarnings: Set<string>;
  textLimiter: RunnerCallDeltaLimiter;
  readonly subagentTextLimiter: RunnerCallDeltaLimiter;
  readonly stderrLimiter: RunnerCallDeltaLimiter;
  readonly toolDeltaLimiter: RunnerCallDeltaLimiter;
}
