import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Task, WorkflowState, PlannerTokenUsage, ImplementerTokenUsage, ValidationResult } from '../../types.js';
import { saveState } from '../../state-persistence.js';
import { addUsage, type UsageCategory } from './tokens.js';

export function refreshCurrentCode(task: Task, projectDir: string): void {
  const filePath = join(projectDir, task.file);
  if (existsSync(filePath)) {
    task.currentCode = readFileSync(filePath, 'utf-8');
  }
}

export function allValidationsPassed(results: ValidationResult[]): boolean {
  return results.length === 0 || results.every((r) => r.passed);
}

export function addUsageAndSave(
  projectDir: string, state: WorkflowState, category: UsageCategory, usage: PlannerTokenUsage | ImplementerTokenUsage | null | undefined,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, next);
  return next;
}

export async function withSignalHandlers(
  handler: () => void,
  fn: () => Promise<void>,
): Promise<void> {
  const onSignal = () => {
    handler();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await fn();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
