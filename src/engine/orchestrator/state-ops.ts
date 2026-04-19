import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { StateAction } from '../../core/types/state-actions.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { OrchestratorCallbacks } from './types.js';
import type { OrchestratorEventPayloadMap } from './events.js';
import { isENOENT } from '../../lib/process/errors.js';
import { transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { emitCostUpdate, emit, emitPlannerStatus } from './events.js';

export function transitionAndSave(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const next = transition(state, action, maxRetries);
  saveState(projectDir, sessionId, next);
  return next;
}

export async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  const filePath = join(projectDir, task.file);
  try {
    const currentCode = await readFile(filePath, 'utf-8');
    return { ...task, currentCode };
  } catch (err) {
    if (isENOENT(err)) return task;
    throw err;
  }
}

export async function refreshAndPersistCode(
  task: Task, projectDir: string, sessionId: string, state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'UPDATE_TASK_CODE', taskId: refreshed.id, code: refreshed.currentCode });
  }
  return { task: refreshed, state };
}

export function addUsageAndSave(
  projectDir: string, sessionId: string, state: WorkflowState, category: UsageCategory, usage: TokenDelta | null | undefined,
  callbacks: OrchestratorCallbacks,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, sessionId, next);
  if (usage) {
    emitCostUpdate(callbacks, next.tokenUsage);
  }
  return next;
}

export type TransitionAndEmitOptions = {
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  action: StateAction;
  eventName: keyof OrchestratorEventPayloadMap;
  status?: 'running' | 'done' | undefined;
  emitData: OrchestratorEventPayloadMap[keyof OrchestratorEventPayloadMap];
};

export function transitionAndEmit(opts: TransitionAndEmitOptions): WorkflowState {
  const { state, projectDir, sessionId, callbacks, action, eventName, status, emitData } = opts;
  const next = transitionAndSave(projectDir, sessionId, state, action);
  if (status) emitPlannerStatus(callbacks, next, status);
  emit(projectDir, sessionId, next, eventName, undefined, emitData);
  return next;
}

export type PlanApprovedContext = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
};

export function emitPlanApproved(state: WorkflowState, ctx: PlanApprovedContext): WorkflowState {
  return transitionAndEmit({
    state,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    callbacks: ctx.callbacks,
    action: { type: 'APPROVE_PLAN' },
    eventName: 'plan_approved',
    status: 'running',
    emitData: {},
  });
}
