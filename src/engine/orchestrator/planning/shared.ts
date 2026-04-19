import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks, PlannerCallbacksContext } from '../types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { createTextHandler, emitError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { labelError } from '../../../utils/format-errors.js';
import type { Planner, PlanResult, PlannerCallbacks, PriorMessage } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
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

export type PlannerCallRunResult = {
  state: WorkflowState;
  result: PlanResult;
};

export type PlannerCallOptions = {
  wctx: PlannerCallbacksContext;
  state: WorkflowState;
  planner: Planner;
  feature: string;
  mode: 'quick' | 'full';
  skillsContext?: string | undefined;
  priorMessages?: PriorMessage[] | undefined;
  collectedQuestions?: ClarificationQuestion[] | undefined;
};

export async function runPlannerCallInContinuationLoop(
  opts: PlannerCallOptions,
): Promise<PlannerCallRunResult> {
  const { wctx, planner, feature, mode, skillsContext, priorMessages, collectedQuestions } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder, sinks, signal } = wctx;
  let state = opts.state;
  const textHandler = createTextHandler(callbacks);
  const conversational = planner.capabilities.supportsConversationalPlanning;

  const loop = await withContinuationLoop<PlanResult>({
    ctx: { projectDir, sessionId, callbacks, signal, sinks },
    state,
    onStateChange: (s) => { state = s; },
    body: async ({ continuationPrompt, recordOutput }) => {
      const prompt = continuationPrompt ?? feature;
      const plannerCallbacks: PlannerCallbacks = {
        onOutput: (text) => { recordOutput(text); textHandler(text); },
        onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
        onSessionExpired: createSessionExpiredHandler({ projectDir, sessionId, callbacks, config, resumeHolder }),
        sessionId,
        persistTranscript: config.workflow.persistTranscript,
        ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
        ...(mode === 'full' && conversational && collectedQuestions
          ? {
              onQuestion: (questions) => {
                for (const q of questions) {
                  if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
                    collectedQuestions.push(q);
                  }
                }
              },
            }
          : {}),
      };

      if (mode === 'quick') {
        const quickPlanFn = planner.quickPlan ?? planner.plan;
        const result = await quickPlanFn.call(planner, prompt, projectDir, plannerCallbacks);
        return { value: result };
      }
      const result = await planner.plan(prompt, projectDir, plannerCallbacks, skillsContext);
      return { value: result };
    },
  });

  state = loop.state;
  return { state, result: loop.value };
}
