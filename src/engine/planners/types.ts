import type { Task, Config, ProjectContext } from '../../types.js';
import type { PricingInfo } from '../pricing.js';
import type { ClarificationQuestion } from '../question-parser.js';

export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase: (phase: string) => void;
  onQuestion?: (questions: ClarificationQuestion[]) => void;
}

export interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface EscalationResult {
  success: boolean;
  output: string;
  code: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface RegenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface PlannerBackend {
  readonly name: string;

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

  isAvailable(): Promise<boolean>;

  getVersion(): Promise<string | null>;

  getPricing(): PricingInfo;
}
