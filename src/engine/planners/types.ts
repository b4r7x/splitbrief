import type { Task } from '../../core/schemas/task.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import type { ChangeDetectionKind } from '../change-detection.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import type { CustomRunnerRuntimePort, RunnerRuntime } from '../runners/types.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import type { TypedSeatCall } from '../runners/typed-output.js';
import type { PlannerTierRole } from '../../core/runners/seat-roles.js';
import type { CliStartGate } from '../runners/start-gate.js';
import type { ApiRuntimeContext } from '../providers/runtime-context.js';

export interface PlannerFactoryOptions {
  /** Canonical CLI identity admitted by the start-readiness gate. */
  trustedCli?: CliStartGate | undefined;
  customRuntime?: CustomRunnerRuntimePort | undefined;
  /** The run's global skills, which the seat may read and never write. */
  skillRoots?: readonly string[] | undefined;
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
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  /** Emitted when the backend reports its native session handle (e.g. Claude Code stream-json session_id). */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /** Emitted when a previously-valid session handle is rejected by the backend. */
  onSessionExpired?: ((previousId: string) => void) | undefined;
  /** Abort signal propagated from the continuation loop so backends can cancel in-flight requests. */
  signal?: AbortSignal | undefined;
  /** Normalized backend call lifecycle events. Orchestrator callbacks bind these to the EventBus. */
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

export interface PlannerOutputCallbacks {
  onOutput: (text: string) => void;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

/** Everything `requestTyped` hands a seat's typed-call binding. */
export type TypedCallContext = Readonly<{
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
  seat: PlannerTierRole;
  /** The attachments a planning session's first turn delivers on the planner thread. */
  images?: Attachment[] | undefined;
  /** The conversation so far, for a planning call issued on a fresh session. */
  priorMessages?: PriorMessage[] | undefined;
}>;

export interface EscalationResult {
  success: boolean;
  output: string;
  code: string | null;
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
  /** The run's skills block, which the hint prompt carries like every other seat call. */
  skillsContext?: string | undefined;
}

export interface Planner extends RunnerRuntime {
  escalateHint(opts: EscalateOptions): Promise<EscalationResult>;

  escalateFull(opts: EscalateOptions): Promise<EscalationResult>;

  review(
    prompt: string,
    projectDir: string,
    callbacks: PlannerOutputCallbacks,
  ): Promise<{ text: string; usage: TokenDelta | null }>;

  /** The binding `requestTyped` calls this seat through. */
  typedCall(ctx: TypedCallContext): TypedSeatCall;

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
   * Present on a seat that reads no files of its own: the model's context, observed on the seat's
   * connection. The planning session then hands it an evidence packet assembled to fit.
   */
  resolvePlanningContext?: ((signal?: AbortSignal) => Promise<ApiRuntimeContext>) | undefined;

  /**
   * Human-readable cause for the most recent `isAvailable()` returning false
   * (e.g. missing API key, unreachable endpoint, auth rejection, empty model list).
   * Backends that can only fail to install do not implement it.
   */
  unavailabilityReason?: () => string | undefined;

  readonly capabilities: PlannerCapabilities;
}
