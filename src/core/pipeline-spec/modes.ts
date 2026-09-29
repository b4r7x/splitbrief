import type { WorkflowMode } from '../schemas/enums.js';

export type ModeGate = 'spec' | 'plan' | 'briefs';

export type ModeSpec = {
  readonly plannerCalls: number | string;
  readonly gates: readonly ModeGate[];
};

export const MODES = {
  quick: { plannerCalls: 1, gates: [] },
  standard: { plannerCalls: 4, gates: ['spec', 'briefs'] },
  speckit: { plannerCalls: '6-7', gates: ['spec', 'plan', 'briefs'] },
} as const satisfies Record<WorkflowMode, ModeSpec>;

export const DEFAULT_MODE = {
  cli: 'standard',
  skill: 'quick',
} as const satisfies Record<'cli' | 'skill', WorkflowMode>;
