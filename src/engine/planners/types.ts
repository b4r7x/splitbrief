import type { Task, TokenDelta, ClarificationQuestion, RunnerRuntime } from '../../types.js';

export type PlannerCapabilities = {
  /** Planner can emit inline clarification questions during planning. */
  supportsConversationalPlanning: boolean;
  /** Planner can produce a short hint before escalating to full fix. */
  supportsHintEscalation: boolean;
  /** Backend exposes a session handle that can be reused on resume (e.g. Claude Code --session-id). */
  supportsSessionResume: boolean;
  /** A queued user message can be injected into the live session in parallel with the current turn. */
  supportsMidStreamInjection: boolean;
};

export interface PriorMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: ((phase: string) => void) | undefined;
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
}

/** Result from a single planning phase. */
export interface PhaseResult {
  /** Resolved artifact content (what should be persisted to disk). */
  text: string;
  filename: string;
  /** Raw planner stdout, retained when it differs from the resolved artifact. */
  rawOutput?: string | undefined;
}

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

export interface Planner extends RunnerRuntime {
  plan(
    feature: string,
    projectDir: string,
    callbacks: PlannerCallbacks,
    skillsContext?: string,
  ): Promise<PlanResult>;

  regenerate(
    prompt: string,
    artifactType: 'spec' | 'plan',
    projectDir: string,
    callbacks: { onOutput: (text: string) => void },
  ): Promise<RegenerateResult>;

  escalateHint(
    task: Task,
    error: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void },
  ): Promise<EscalationResult>;

  escalateFull(
    task: Task,
    error: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void },
  ): Promise<EscalationResult>;

  quickPlan(
    feature: string,
    projectDir: string,
    callbacks: PlannerCallbacks,
  ): Promise<PlanResult>;

  review(
    prompt: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void },
  ): Promise<{ text: string; usage: TokenDelta | null }>;

  injectUserTurn?: (text: string, projectDir: string) => Promise<void>;

  readonly capabilities: PlannerCapabilities;
}
