import type { Task } from '../../core/schemas/task.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import type { CustomRunnerRuntimePort, RunnerRuntime } from '../runners/types.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import type { CliStartGate } from '../runners/start-gate.js';

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
  /** Backend exposes a session handle that can be reused on resume (e.g. Claude Code --session-id). */
  supportsSessionResume: boolean;
  /** Backend honours an effort/reasoning hint (Claude Code prefix, Codex flag, Anthropic thinking, OpenAI reasoning_effort). */
  supportsEffort: boolean;
  /** Backend can accept image attachments (vision models, --image flag, content blocks, etc.). */
  supportsImages: boolean;
  /** Planner can summarize its own prior transcript for compaction. */
  supportsSelfSummarisation: boolean;
};

/** Preset for session-based conversational planners (Claude Code, Agent SDK, codex). */
export const CONVERSATIONAL_CAPS: PlannerCapabilities = {
  supportsConversationalPlanning: true,
  supportsHintEscalation: false,
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

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: ((phase: Phase) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  /** Emitted when the backend reports its native session handle (e.g. Claude Code --session-id). */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /** Emitted when a previously-valid session handle is rejected by the backend. */
  onSessionExpired?: ((previousId: string) => void) | undefined;
  /** Session ID for agent planners that write files to the session directory. */
  sessionId?: string | undefined;
  /** Whether to persist planner output as transcript messages (mirrors config.workflow.persistTranscript). */
  persistTranscript?: boolean | undefined;
  /**
   * Prior conversation messages to inject into the first planner phase on resume.
   * Set by the orchestrator when the backend has no native session resume OR after a
   * session-expired fallback. Consumed by backends in their own shape (prompt prefix vs
   * OpenAI messages array).
   */
  priorMessages?: PriorMessage[] | undefined;
  /**
   * Image attachments to deliver with the next planner call. Drained from the
   * attachments store at planning-phase entry. Backends that report
   * `capabilities.supportsImages: false` should never receive a non-empty list
   * (the orchestrator drops them with a `planner_attachments_dropped` event).
   * Multi-phase backends consume them on the first invocation only.
   */
  attachments?: Attachment[] | undefined;
  /** Validation toolchain discovered by prior research or restored workflow state. */
  discoveredValidation?: DiscoveredValidation | undefined;
  /** Abort signal propagated from the continuation loop so backends can cancel in-flight requests. */
  signal?: AbortSignal | undefined;
  /** Normalized backend call lifecycle events. Orchestrator callbacks bind these to the EventBus. */
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  /** Emitted when a parsed Task Brief contains `###` sections outside the grammar and they are dropped. */
  onWarning?: ((message: string) => void) | undefined;
}

export interface PlannerOutputCallbacks {
  onOutput: (text: string) => void;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}

/** Result from a single planning phase. */
export interface PhaseResult {
  /** Resolved artifact content (what should be persisted to disk). */
  text: string;
  filename: string;
  /** Raw planner stdout, retained when it differs from the resolved artifact. */
  rawOutput?: string | undefined;
}

/**
 * Result of a planner run. The durable contract handed to the implementer is the
 * `tasks` array — each entry is the persisted form of a Product Task Brief v1
 * (see `docs/TASK-CONTRACT.md`). `spec` and `plan` are optional support documents
 * that may be empty for instant/quick modes; they exist to feed brief compilation,
 * not as the primary handoff artifact.
 */
export interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: TokenDelta | null;
  /** Phase outputs to be persisted by the orchestrator. */
  phases?: PhaseResult[] | undefined;
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

export interface PlanOptions {
  feature: string;
  projectDir: string;
  callbacks: PlannerCallbacks;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
}

export interface EscalateOptions {
  task: Task;
  error: string;
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
  languageContext?: LanguageContext | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  fileIgnoreProjectDir?: string | undefined;
}

export interface RegenerateOptions {
  prompt: string;
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
}

export interface Planner extends RunnerRuntime {
  plan(opts: PlanOptions): Promise<PlanResult>;

  regenerate(opts: RegenerateOptions): Promise<RegenerateResult>;

  escalateHint(opts: EscalateOptions): Promise<EscalationResult>;

  escalateFull(opts: EscalateOptions): Promise<EscalationResult>;

  quickPlan(opts: PlanOptions): Promise<PlanResult>;

  /**
   * One-shot planner call for `instant` mode. Mirrors {@link Planner.quickPlan}
   * but uses the instant prompt: emits the narrowest useful Task Brief set with
   * no spec/plan support documents (a single brief is acceptable). Optional:
   * backends that don't implement it fall back to `quickPlan ?? plan` via the
   * dispatcher in `runInstantPlanning`. Ignores `skillsContext`.
   */
  instantPlan?: (opts: PlanOptions) => Promise<PlanResult>;

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

  injectUserTurn?: (opts: PlannerUserTurnOptions) => Promise<TokenDelta | null>;

  /**
   * Human-readable cause for the most recent `isAvailable()` returning false
   * (e.g. missing API key, unreachable endpoint, auth rejection, empty model list).
   * Backends that can only fail to install do not implement it.
   */
  unavailabilityReason?: () => string | undefined;

  readonly capabilities: PlannerCapabilities;
}
