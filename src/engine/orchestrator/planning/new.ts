import { join } from 'node:path';
import type { WorkflowState } from '../../../core/types/state-actions.js';
import type { ClarificationQuestion } from '../../../core/types/events.js';
import type { Planner } from '../../planners/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildSkillsSection } from '../../skills/index.js';
import { createTextHandler, emitPlanApproved } from '../events.js';
import { addUsageAndSave, transitionAndSave, transitionAndEmit, createSessionExpiredHandler } from '../helpers.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { runApprovalLoop } from '../approval.js';
import { withContinuationLoop } from '../continuation-loop.js';
import { handleRewindSpec, handleRewindPlan } from './rewind.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  persistPhases,
  regenerateTasks,
  regeneratePlanAndTasks,
  MAX_CLARIFICATION_QUESTIONS,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';

async function runNewPlanning(
  opts: PlanningPhaseOptions,
  skipPlanApproval: boolean,
  metadata: SpecMetadata,
  skillsContext: string | undefined,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder, sinks } = wctx;
  const signal = wctx.signal;
  const conversational = planner.capabilities.supportsConversationalPlanning;
  let feature = opts.feature;
  const collectedQuestions: ClarificationQuestion[] = [];

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    feature = prefix + feature;
  }

  const textHandler = createTextHandler(callbacks);
  type PlanFnResult = Awaited<ReturnType<Planner['plan']>>;
  let planResult: PlanFnResult;

  try {
    const loop = await withContinuationLoop<PlanFnResult>({
      ctx: { projectDir, sessionId, callbacks, signal, sinks },
      state,
      onStateChange: (s) => { state = s; },
      body: async ({ continuationPrompt, recordOutput }) => {
        const prompt = continuationPrompt ?? feature;
        const result = await planner.plan(prompt, projectDir, {
          onOutput: (text) => { recordOutput(text); textHandler(text); },
          onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
          onSessionExpired: createSessionExpiredHandler({ projectDir, sessionId, callbacks, config, resumeHolder }),
          onQuestion: conversational ? (questions) => {
            for (const q of questions) {
              if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
                collectedQuestions.push(q);
              }
            }
          } : undefined,
          sessionId,
          persistTranscript: config.workflow.persistTranscript,
          ...(resumeHolder && resumeHolder.messages.length > 0 ? { priorMessages: resumeHolder.messages } : {}),
        }, skillsContext);
        return { value: result };
      },
    });
    state = loop.state;
    planResult = loop.value;
  } catch (err) {
    return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  let tasks = planResult.tasks;

  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, callbacks);

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'RESEARCH_DONE' }, eventName: 'research_done', emitData: {} });

  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications(collectedQuestions, projectDir, sessionId, state, callbacks.onQuestionAsked, config.workflow.persistTranscript, metadata, planner, callbacks);
    ({ state, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, state, metadata, skillsContext));
  }

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'SPEC_DONE' }, eventName: 'spec_done', status: 'running', emitData: {} });

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);

  if (!config.workflow.autoApproveSpec) {
    const specLoop = await runApprovalLoop({ type: 'spec', filePath: specPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = specLoop.state;
    if (specLoop.rejected) return { state, tasks: [], cancelled: true };
    if (specLoop.regenerated) {
      ({ state, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, state, metadata, skillsContext));
    }
  }

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_SPEC' }, eventName: 'spec_approved', status: 'running', emitData: {} });

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'PLAN_DONE', tasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: tasks.length } });

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);

  if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
    const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
    if (planLoop.regenerated) {
      const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
      state = taskRegen.state;
      tasks = taskRegen.tasks;
    }
  }

  state = emitPlanApproved(state, { projectDir, sessionId, callbacks });

  return { state, tasks, cancelled: false };
}

export async function runFullPlanning(opts: PlanningPhaseOptions, skipPlanApproval: boolean): Promise<PlanningPhaseResult> {
  const { wctx, selectedSkills } = opts;
  const { projectDir, sessionId, metadata } = wctx;
  let { state } = opts;
  const skillsContext = selectedSkills?.length ? await buildSkillsSection(selectedSkills) : undefined;

  const rewindPending = opts.rewindPending;
  if (rewindPending) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'CLEAR_REWIND_PENDING' });
    if (rewindPending.target === 'spec') {
      return handleRewindSpec(opts, rewindPending, skipPlanApproval, metadata, skillsContext, state);
    }
    return handleRewindPlan(opts, rewindPending, skipPlanApproval, metadata, state);
  }

  return runNewPlanning(opts, skipPlanApproval, metadata, skillsContext, state);
}
