import type { ActiveRunnerRole } from './runners/seat-roles.js';
import { capitalize } from '../utils/capitalize.js';

export function formatStageLabel(stage: string): string {
  // The rail stage is `review`; the phase key for the same step is `final-review`. One word on both.
  if (stage === 'final-review') return 'Review';
  return stage
    .split('-')
    .map((word) => capitalize(word))
    .join(' ');
}

export function formatRoleLabel(role: ActiveRunnerRole | 'validator'): string {
  return capitalize(role);
}
