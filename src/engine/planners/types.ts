import type { Task, Config, PlannerTokenUsage } from '../../types.js';
import type { PricingInfo } from '../../core/providers/pricing.js';
import type { ClarificationQuestion } from '../parsers/question-parser.js';

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: (phase: string) => void;
  onQuestion?: (questions: ClarificationQuestion[]) => void;
}

export interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: PlannerTokenUsage | null;
}

export interface EscalationResult {
  success: boolean;
  output: string;
  code: string | null;
  usage: PlannerTokenUsage | null;
}

export interface RegenerateResult {
  text: string;
  usage: PlannerTokenUsage | null;
}

export interface Planner {
  readonly name: string;
  readonly conversational: boolean;

  plan(
    feature: string,
    projectDir: string,
    config: Config,
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

  quickPlan?(
    feature: string,
    projectDir: string,
    config: Config,
    callbacks: PlannerCallbacks,
  ): Promise<PlanResult>;

  isAvailable(): Promise<boolean>;

  review(
    prompt: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void },
  ): Promise<{ text: string; usage: PlannerTokenUsage | null }>;

  getVersion(): Promise<string | null>;

  getPricing(): PricingInfo;
}
