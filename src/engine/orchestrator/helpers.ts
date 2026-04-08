import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Task, WorkflowState, PlannerTokenUsage, ImplementerTokenUsage, ValidationResult, OrchestratorCallbacks, StateAction } from '../../types.js';
import { transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { addUsage, type UsageCategory } from './tokens.js';

export function transitionAndSave(
  projectDir: string,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const next = transition(state, action, maxRetries);
  saveState(projectDir, next);
  return next;
}

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
  callbacks: OrchestratorCallbacks,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, next);
  if (usage) {
    callbacks.onEvent({ type: 'cost-update', ts: Date.now(), tokenUsage: next.tokenUsage });
  }
  return next;
}

interface SignalError extends Error {
  signal: 'SIGINT' | 'SIGTERM';
}

function makeSignalError(signal: 'SIGINT' | 'SIGTERM'): SignalError {
  const err = new Error(`Process received ${signal}`) as SignalError;
  err.name = 'SignalError';
  err.signal = signal;
  return err;
}

export function isSignalError(e: unknown): e is SignalError {
  return e instanceof Error && e.name === 'SignalError';
}

export async function withSignalHandlers(
  handler: () => void,
  fn: () => Promise<void>,
): Promise<void> {
  let receivedSignal: 'SIGINT' | 'SIGTERM' | null = null;

  const onSignal = (sig: 'SIGINT' | 'SIGTERM') => {
    receivedSignal = sig;
    handler();
  };

  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    await fn();
    if (receivedSignal) throw makeSignalError(receivedSignal);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
