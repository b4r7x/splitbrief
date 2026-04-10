import type { Task, TokenDelta, ClarificationQuestion, Backend } from '../../types.js';

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: ((phase: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
}

export interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: TokenDelta | null;
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

export interface Planner extends Backend {
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
}
