import type { StateAction } from '../../core/state/types.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { confinedExists, confinedReadFileAsync } from '../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../lib/path-confinement.js';
import { matches } from '../../utils/error.js';

const isPathEscape = matches('path-confined-escape');
import { transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { publishCostUpdate } from './events.js';
import type { WorkflowPersistenceContext } from './types.js';

export function mergePersistedMessageQueue(ref: SessionRef, state: WorkflowState): WorkflowState {
  const persisted = loadState(ref);
  if (!persisted) return state;

  const byId = new Map(persisted.messageQueue.map((message) => [message.id, message]));
  for (const current of state.messageQueue) {
    const persistedMessage = byId.get(current.id);
    byId.set(
      current.id,
      persistedMessage
        ? {
            ...persistedMessage,
            ...current,
            deliveredViaNative: persistedMessage.deliveredViaNative || current.deliveredViaNative,
            drainedAt: current.drainedAt ?? persistedMessage.drainedAt,
          }
        : current,
    );
  }

  return { ...state, messageQueue: [...byId.values()] };
}

export function transitionAndSave(
  ref: SessionRef,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const base = mergePersistedMessageQueue(ref, state);
  const next = transition(base, action, { maxRetries });
  saveState(ref, next);
  return next;
}

async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  assertPathConfined(task.file, projectDir);
  try {
    if (!confinedExists(projectDir, task.file)) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    const currentCode = await confinedReadFileAsync(projectDir, task.file);
    if (currentCode === null) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    return { ...task, currentCode };
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    throw err;
  }
}

export async function refreshAndPersistCode(
  task: Task,
  ref: SessionRef,
  state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, ref.projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'UPDATE_TASK_CODE',
      taskId: refreshed.id,
      code: refreshed.currentCode,
    });
  } else if (task.currentCode !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'CLEAR_TASK_CODE',
      taskId: refreshed.id,
    });
  }
  return { task: refreshed, state };
}

export function addUsageAndSave(
  ctx: WorkflowPersistenceContext,
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
): WorkflowState {
  const base = mergePersistedMessageQueue(ctx, state);
  const next = addUsage(base, category, usage);
  saveState(ctx, next);
  if (usage) {
    publishCostUpdate({ bus: ctx.bus, phase: next.phase }, next.tokenUsage);
  }
  return next;
}
