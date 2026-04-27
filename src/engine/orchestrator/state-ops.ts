import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { StateAction } from '../../core/types/state-actions.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import { isENOENT } from '../../lib/process/errors.js';
import { transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { publishCostUpdate, publishPlannerStatus, publishEvent } from './events.js';

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
    if (isENOENT(err)) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    throw err;
  }
}

export async function refreshAndPersistCode(
  task: Task, projectDir: string, sessionId: string, state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'UPDATE_TASK_CODE', taskId: refreshed.id, code: refreshed.currentCode });
  } else if (task.currentCode !== undefined) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'CLEAR_TASK_CODE', taskId: refreshed.id });
  }
  return { task: refreshed, state };
}

export function addUsageAndSave(
  projectDir: string, sessionId: string, state: WorkflowState, category: UsageCategory, usage: TokenDelta | null | undefined,
  bus: EventBus,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, sessionId, next);
  if (usage) {
    publishCostUpdate(bus, next.phase, next.tokenUsage);
  }
  return next;
}

export type PlanApprovedBusContext = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
};

export function publishPlanApproved(state: WorkflowState, ctx: PlanApprovedBusContext): WorkflowState {
  const next = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'APPROVE_PLAN' });
  publishPlannerStatus(ctx.bus, next, 'running');
  publishEvent(ctx.bus, { type: 'plan_approved', ts: Date.now(), phase: next.phase });
  return next;
}
