import type { WorkflowMode } from '../schemas/enums.js';

export type ModeGate = 'spec' | 'plan' | 'briefs';

export type ModeSpec = {
  readonly plannerCalls: number | string;
  readonly briefCap: number;
  readonly gates: readonly ModeGate[];
};

export const MODES = {
  quick: { plannerCalls: 1, briefCap: 5, gates: [] },
  standard: { plannerCalls: 4, briefCap: 12, gates: ['spec', 'briefs'] },
  speckit: { plannerCalls: '6-7', briefCap: 12, gates: ['spec', 'plan', 'briefs'] },
} as const satisfies Record<WorkflowMode, ModeSpec>;

export const MODE_UPGRADE = {
  quickToStandard: { files: 5, briefs: 5 },
  standardCap: 12,
} as const;

export const DEFAULT_MODE = {
  cli: 'standard',
  skill: 'quick',
} as const satisfies Record<'cli' | 'skill', WorkflowMode>;
