import type { WorkflowState, Task } from '../../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { emitError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { labelError } from '../../../utils/format-errors.js';
import type { Planner, PlanResult } from '../../planners/types.js';
import type { SkillMeta } from '../../skills/discovery.js';
import { drainQueue, formatDrainedMessages } from '../queue.js';
import { regenerateFromFeedback } from '../continuation.js';

export const MAX_CLARIFICATION_QUESTIONS = 5;

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  selectedSkills?: SkillMeta[] | undefined;
  rewindPending?: { target: 'spec' | 'plan'; comment?: string | undefined } | undefined;
};

export type PlanningPhaseResult = { state: WorkflowState; tasks: Task[]; cancelled: boolean };

export function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  callbacks: OrchestratorCallbacks,
): { state: WorkflowState; prefix: string } {
  const drain = drainQueue(projectDir, sessionId, state, callbacks);
  if (drain.messages.length === 0) return { state, prefix: '' };
  return { state: drain.state, prefix: formatDrainedMessages(drain.messages) };
}

export function persistPhases(projectDir: string, sessionId: string, phases: PlanResult['phases'], metadata: SpecMetadata): void {
  for (const phase of phases ?? []) {
    writeSpecFile(projectDir, sessionId, phase.filename, phase.text, metadata);
  }
}

export function handlePlanningFailure(
  err: unknown, projectDir: string, sessionId: string, state: WorkflowState, callbacks: PlannerCallbacksContext['callbacks'],
): { state: WorkflowState; tasks: Task[]; cancelled: true } {
  emitError(callbacks, labelError('Planning failed', err));
  return { state: transitionAndSave(projectDir, sessionId, state, { type: 'CANCEL' }), tasks: [], cancelled: true };
}

export async function regenerateTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  state: WorkflowState,
  metadata: SpecMetadata,
  planOverride?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const result = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, state, metadata, planOverride,
  });
  return { state: result.state, tasks: result.tasks };
}

export async function regeneratePlanAndTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  state: WorkflowState,
  metadata: SpecMetadata,
  skillsContext?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const planRegen = await regenerateFromFeedback('plan', {
    projectDir, sessionId, planner, callbacks, state, metadata, skillsContext,
  });
  const taskRegen = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, state: planRegen.state, metadata, planOverride: planRegen.plan,
  });
  return { state: taskRegen.state, tasks: taskRegen.tasks };
}

export async function regenerateTasksIfNeeded(
  regenerated: boolean,
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  state: WorkflowState,
  tasks: Task[],
  metadata: SpecMetadata,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!regenerated) return { state, tasks };
  return regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
}
