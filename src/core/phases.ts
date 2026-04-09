import type { Phase } from './types/index.js';

const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);

export function phaseRole(phase: Phase): 'planner' | 'implementer' {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
}

export const CANCELLABLE_PHASES: ReadonlySet<Phase> = new Set([
  'researching',
  'specifying',
  'reviewing-spec',
  'planning',
  'reviewing-plan',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

export const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'reviewing-spec', 'reviewing-plan', 'implementing',
  'validating-task', 'escalating', 'final-review',
]);
