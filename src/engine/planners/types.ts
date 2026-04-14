import type { Task, TokenDelta, ClarificationQuestion, RunnerRuntime } from '../../types.js';

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: ((phase: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
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

  /** True when the planner can emit inline clarification questions during planning. */
  readonly supportsConversationalPlanning?: boolean | undefined;
}
