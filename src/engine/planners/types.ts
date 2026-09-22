import type { Task } from '../../core/schemas/task.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import type { ChangeDetectionKind } from '../change-detection.js';
import type { PlannerCall } from '../../core/schemas/run-step.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import type {
  CustomRunnerRuntimePort,
  DeclaredArtifactReceipt,
  PreparedPlannerInvocation,
  RunnerRuntime,
} from '../runners/types.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { CliStartGate } from '../runners/start-gate.js';
import {
  OwnedPlannerArtifactSchema,
  type DeclaredArtifactLease,
  type OwnedPlannerArtifact,
  type PlannerArtifactTransport,
  type PlannerSessionScope,
  type PlannerArtifactAttemptId,
  type PlannerArtifactBatchId,
  type PlannerArtifactProgramId,
  type PlannerArtifactSemanticId,
} from '../../core/schemas/planner-artifact.js';

export type {
  DeclaredArtifactLease,
  OwnedPlannerArtifact,
  PreparedPlannerInvocation,
  PlannerArtifactTransport,
  PlannerSessionScope,
};

/** Internal result extension used to carry the validated declared-file receipt
 * from the runtime adapter into the phase-owned artifact. */
export type PlannerInvokeResult = RunnerCallResult &
  Readonly<{
    ownedArtifactReceipt?: DeclaredArtifactReceipt | undefined;
  }>;

export interface PlannerFactoryOptions {
  /** Canonical CLI identity admitted by the start-readiness gate. */
  trustedCli?: CliStartGate | undefined;
  customRuntime?: CustomRunnerRuntimePort | undefined;
}

export type PlannerCapabilities = {
  /** Planner can emit inline clarification questions during planning. */
  supportsConversationalPlanning: boolean;
  /** Planner can produce a short hint before escalating to full fix. */
  supportsHintEscalation: boolean;
  /** Backend exposes a session handle that can be reused on resume (e.g. Claude Code --resume). */
  supportsSessionResume: boolean;
  /** Backend honours an effort/reasoning hint (Claude Code prefix, Codex flag, Anthropic thinking, OpenAI reasoning_effort). */
  supportsEffort: boolean;
  /** Backend can accept image attachments (vision models, --image flag, content blocks, etc.). */
  supportsImages: boolean;
  /** Planner can summarize its own prior transcript for compaction. */
  supportsSelfSummarisation: boolean;
};

/** Preset for session-based conversational planners (Claude Code). */
export const CONVERSATIONAL_CAPS: PlannerCapabilities = {
  supportsConversationalPlanning: true,
  supportsHintEscalation: true,
  supportsSessionResume: true,
  supportsEffort: true,
  supportsImages: true,
  supportsSelfSummarisation: true,
};

/** Preset for one-shot API planners (OpenAI-compatible endpoints). */
export const ONE_SHOT_API_CAPS: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: true,
};

export interface PriorMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlannerSummaryMessage {
  role: string;
  text: string;
}

export interface PlannerCallEventCallbacks {
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

export type PlannerSummaryOptions = {
  projectDir?: string | undefined;
  signal?: AbortSignal | undefined;
  callbacks?: PlannerCallEventCallbacks | undefined;
  role?: Extract<RunnerCallContext['role'], 'summary' | 'compaction'> | undefined;
};

export type PlannerStructuredSummaryOptions = PlannerSummaryOptions & {
  previousSummary?: StructuredSummary | undefined;
};

export type PlannerUserTurnOptions = {
  text: string;
  projectDir: string;
  signal?: AbortSignal | undefined;
  callbacks?: PlannerCallEventCallbacks | undefined;
  callContext?: RunnerCallContext | undefined;
};

/** Delivery is decided by the seat's session, never by whether the turn reported usage. */
export type PlannerUserTurnResult =
  | { status: 'delivered'; usage: TokenDelta | null }
  | { status: 'not-delivered'; reason: 'not-ready' };

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: ((phase: Phase) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  /** Emitted when the backend reports its native session handle (e.g. Claude Code stream-json session_id). */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /** Emitted when a previously-valid session handle is rejected by the backend. */
  onSessionExpired?: ((previousId: string) => void) | undefined;
  /** Session ID for agent planners that write files to the session directory. */
  sessionId?: string | undefined;
  /** Abort signal propagated from the continuation loop so backends can cancel in-flight requests. */
  signal?: AbortSignal | undefined;
  /** Normalized backend call lifecycle events. Orchestrator callbacks bind these to the EventBus. */
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  /** Non-fatal Task Brief parse diagnostics: dropped out-of-grammar sections and the zero-task reason. */
  onWarning?: ((message: string) => void) | undefined;
}

export interface PlannerOutputCallbacks {
  onOutput: (text: string) => void;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

/** Result from a single planning phase, owned by its current physical call. */
export type PhaseResult = Readonly<{
  artifact: OwnedPlannerArtifact;
  rawOutput?: string | undefined;
}>;

export type PlannerArtifactLogicalName = 'research.md' | 'spec.md' | 'plan.md' | 'tasks.md';

export type PlannerArtifactRequest = Readonly<{
  semanticId: PlannerArtifactSemanticId;
  programId: PlannerArtifactProgramId | null;
  batchId: PlannerArtifactBatchId | null;
  attemptId: PlannerArtifactAttemptId;
  logicalName: PlannerArtifactLogicalName;
  transport: PlannerArtifactTransport;
}>;

export function isOwnedPlannerArtifactFor(
  request: PlannerArtifactRequest,
  input: unknown,
): input is OwnedPlannerArtifact {
  const parsed = OwnedPlannerArtifactSchema.safeParse(input);
  if (!parsed.success) return false;
  const artifact = parsed.data;
  if (
    artifact.semanticId !== request.semanticId ||
    artifact.programId !== request.programId ||
    artifact.batchId !== request.batchId ||
    artifact.attemptId !== request.attemptId ||
    artifact.logicalName !== request.logicalName ||
    artifact.transport !== request.transport.kind
  ) {
    return false;
  }
  if (request.transport.kind !== 'declared-file') return true;
  if (request.transport.lease.attemptId !== request.attemptId) return false;
  if (artifact.sourceReceipt.kind !== 'declared-file') return false;
  return artifact.sourceReceipt.leaseId === request.transport.lease.leaseId;
}

/** The planner calls that turn a prompt into one markdown planning document. */
export type PlannerDocumentCall = Extract<PlannerCall, 'research' | 'spec' | 'plan' | 'tasks'>;

const DOCUMENT_CALLS: readonly PlannerCall[] = ['research', 'spec', 'plan', 'tasks'];

export function isPlannerDocumentCall(call: PlannerCall): call is PlannerDocumentCall {
  return DOCUMENT_CALLS.includes(call);
}

/**
 * Everything one planner call reads. The caller owns the artifacts: it reads
 * `research`/`spec`/`plan` back from the session directory and hands them in, so
 * a call never depends on a sibling call having happened in the same process.
 */
export interface PhaseInputs {
  feature: string;
  research?: string | undefined;
  spec?: string | undefined;
  plan?: string | undefined;
  projectContext: string;
  languageContext: LanguageContext;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  /**
   * Text that leads the built prompt: the steer the operator typed, the messages
   * queued for this call, and the rejections the planner has to respect.
   */
  promptPrefix?: string | undefined;
  /**
   * Text that trails the built prompt. The continuation block a stateless seat
   * needs: the partial its cut attempt produced and what the operator said.
   */
  promptSuffix?: string | undefined;
  /**
   * Replaces the built prompt with one user turn. Only a seat holding the native
   * session this step already ran on gets one: the conversation still carries the
   * step's prompt, so re-sending it would ask the same question twice.
   */
  continuationTurn?: string | undefined;
  /**
   * Prior conversation messages to inject into the first planner call of the
   * process. Set by the orchestrator when the backend has no native session
   * resume OR after a session-expired fallback. Consumed by backends in their own
   * shape (prompt prefix vs OpenAI messages array).
   */
  priorMessages?: PriorMessage[] | undefined;
  /**
   * Image attachments to deliver with this call. Drained from the attachments
   * store at planning-phase entry. Backends that report
   * `capabilities.supportsImages: false` should never receive a non-empty list
   * (the orchestrator drops them with a `planner_attachments_dropped` event).
   * A planner consumes them on its first call only.
   */
  attachments?: Attachment[] | undefined;
  /** The `tasks` call compiles briefs straight from the feature: one call, no spec, no plan. */
  quickPlan?: { trivial: boolean } | undefined;
}

export interface RunPhaseInput {
  call: PlannerDocumentCall;
  projectDir: string;
  inputs: PhaseInputs;
  callbacks: PlannerCallbacks;
}

/** What one planner call produced: its text, its owned artifact, its spend. */
export interface ArtifactCallResult {
  kind: 'artifact';
  text: string;
  usage: TokenDelta | null;
  artifact: PhaseResult;
  /** Parsed Product Task Briefs; the `tasks` call only. */
  tasks?: Task[] | undefined;
}

export type PhaseCallResult =
  | ArtifactCallResult
  | {
      kind: 'conversation';
      text: string;
      usage: TokenDelta | null;
      questions: ClarificationQuestion[];
    };

/**
 * Result of running a mode's document calls end to end, outside a durable run.
 * The contract handed to the implementer is the `tasks` array — each entry is the
 * persisted form of a Product Task Brief v1 (see `docs/TASK-CONTRACT.md`).
 */
export interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: TokenDelta | null;
  phases: PhaseResult[];
}

export interface EscalationResult {
  success: boolean;
  output: string;
  code: string | null;
  usage: TokenDelta | null;
}

export interface RegenerateResult {
  text: string;
  usage: TokenDelta | null;
}

export interface EscalateOptions {
  task: Task;
  error: string;
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
  languageContext?: LanguageContext | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  fileIgnoreProjectDir?: string | undefined;
  /** Baseline the caller's workspace declares; sniffed from the directory when absent. */
  changeDetection?: ChangeDetectionKind | undefined;
  /** The implementer's own account of why it stopped, when it gave one. */
  handBack?: string | undefined;
}

export interface RegenerateOptions {
  prompt: string;
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
}

export interface Planner extends RunnerRuntime {
  /** One planner call: one prompt, one document, one owned artifact. */
  runPhase(input: RunPhaseInput): Promise<PhaseCallResult>;

  regenerate(opts: RegenerateOptions): Promise<RegenerateResult>;

  escalateHint(opts: EscalateOptions): Promise<EscalationResult>;

  escalateFull(opts: EscalateOptions): Promise<EscalationResult>;

  review(
    prompt: string,
    projectDir: string,
    callbacks: PlannerOutputCallbacks,
  ): Promise<{ text: string; usage: TokenDelta | null }>;

  summarize(
    messages: PlannerSummaryMessage[],
    opts?: PlannerSummaryOptions | undefined,
  ): Promise<{ text: string; usage: TokenDelta | null }>;

  summarizeStructured?(
    messages: PlannerSummaryMessage[],
    opts?: PlannerStructuredSummaryOptions | undefined,
  ): Promise<{ text: string; structured: StructuredSummary | null; usage: TokenDelta | null }>;

  injectUserTurn?: (opts: PlannerUserTurnOptions) => Promise<PlannerUserTurnResult>;

  /**
   * Human-readable cause for the most recent `isAvailable()` returning false
   * (e.g. missing API key, unreachable endpoint, auth rejection, empty model list).
   * Backends that can only fail to install do not implement it.
   */
  unavailabilityReason?: () => string | undefined;

  readonly capabilities: PlannerCapabilities;
}
