import type { Phase } from '../types/index.js';
import { PHASES } from '../types/schemas/enums.js';

export function phaseOrder(phase: Phase): number {
  return PHASES.indexOf(phase);
}

const TERMINAL: ReadonlySet<Phase> = new Set(['idle', 'complete']);

export function canReviseSpec(phase: Phase): boolean {
  return !TERMINAL.has(phase) && phaseOrder(phase) >= phaseOrder('reviewing-spec');
}

export function canRevisePlan(phase: Phase): boolean {
  return !TERMINAL.has(phase) && phaseOrder(phase) >= phaseOrder('reviewing-plan');
}

export function canRedoTask(phase: Phase): boolean {
  return phase === 'implementing' || phase === 'validating-task' || phase === 'escalating';
}
