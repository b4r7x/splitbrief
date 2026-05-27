import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { StateAction } from '../../core/state/types.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import { isENOENT } from '../../lib/process/errors.js';
import { assertPathConfined } from '../../lib/path-confinement.js';
import { transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { publishCostUpdate, publishPlannerStatus } from './events.js';

export function mergePersistedMessageQueue(projectDir: string, sessionId: string, state: WorkflowState): WorkflowState {
  const persisted = loadState(projectDir, sessionId);
  if (!persisted) return state;

  const byId = new Map(persisted.messageQueue.map(message => [message.id, message]));
  for (const current of state.messageQueue) {
    const persistedMessage = byId.get(current.id);
    byId.set(current.id, persistedMessage
      ? {
        ...persistedMessage,
        ...current,
        deliveredViaNative: persistedMessage.deliveredViaNative || current.deliveredViaNative,
        drainedAt: current.drainedAt ?? persistedMessage.drainedAt,
      }
      : current);
  }

  return { ...state, messageQueue: [...byId.values()] };
}

export function transitionAndSave(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const base = mergePersistedMessageQueue(projectDir, sessionId, state);
  const next = transition(base, action, maxRetries);
  saveState(projectDir, sessionId, next);
  return next;
}

async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  assertPathConfined(task.file, projectDir);
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
  const base = mergePersistedMessageQueue(projectDir, sessionId, state);
  const next = addUsage(base, category, usage);
  saveState(projectDir, sessionId, next);
  if (usage) {
    publishCostUpdate({ bus: bus, phase: next.phase }, next.tokenUsage);
  }
  return next;
}

export function publishPlanApproved(state: WorkflowState, bus: EventBus): WorkflowState {
  publishPlannerStatus(bus, state, 'running');
  bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });
  return state;
}
