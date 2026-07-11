import { capitalize } from '../utils/capitalize.js';

export function formatStageLabel(stage: string): string {
  return stage
    .split('-')
    .map((word) => capitalize(word))
    .join(' ');
}

export function formatRoleLabel(role: 'planner' | 'implementer' | 'validator'): string {
  return capitalize(role);
}
