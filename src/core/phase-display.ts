import type { ActiveRunnerRole } from './runners/seat-roles.js';
import { capitalize } from '../utils/capitalize.js';

export function formatStageLabel(stage: string): string {
  return stage
    .split('-')
    .map((word) => capitalize(word))
    .join(' ');
}

export function formatRoleLabel(role: ActiveRunnerRole | 'validator'): string {
  return capitalize(role);
}
