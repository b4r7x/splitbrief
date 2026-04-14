import { join } from 'node:path';
import type { OrchestratorCallbacks, WorkflowState, Task, SkillMeta, StateAction, ClarificationQuestion } from '../../types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../types.js';
import type { OrchestratorEventPayloadMap } from '../../core/types/events.js';
import type { PlannerCallbacksContext } from './types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { parseTasks } from '../spec/parser.js';
import { buildPlanPromptFromSpec } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildSkillsSection } from '../skills/index.js';
import type { Planner, PlanResult } from '../planners/types.js';
import { buildProjectContextMarkdown } from '../planners/context.js';
import { emit, createTextHandler, emitError, emitPlannerStatus } from './events.js';
import { addUsageAndSave, transitionAndSave, runPlannerReview } from './helpers.js';
import { labelError } from '../../utils/format.js';
import { collectAndPersistClarifications } from './clarifications.js';
import { runApprovalLoop } from './approval.js';

const MAX_CLARIFICATION_QUESTIONS = 5;

/** Persist phases to disk (orchestrator owns file-writing, not the planner). */
function persistPhases(projectDir: string, sessionId: string, phases: PlanResult['phases'], metadata: SpecMetadata): void {
  for (const phase of phases ?? []) {
    writeSpecFile(projectDir, sessionId, phase.filename, phase.text, metadata);
  }
}

function handlePlanningFailure(
  err: unknown, projectDir: string, sessionId: string, state: WorkflowState, callbacks: PlannerCallbacksContext['callbacks'],
): { state: WorkflowState; tasks: Task[]; cancelled: true } {
  emitError(callbacks, labelError('Planning failed', err));
  return { state: transitionAndSave(projectDir, sessionId, state, { type: 'CANCEL' }), tasks: [], cancelled: true };
}

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  selectedSkills?: SkillMeta[] | undefined;
};

type TransitionAndEmitOptions<T extends keyof OrchestratorEventPayloadMap> = {
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  action: StateAction;
  eventName: T;
  status?: 'running' | 'done' | undefined;
  emitData: OrchestratorEventPayloadMap[T];
};

function transitionAndEmit<T extends keyof OrchestratorEventPayloadMap>(
  opts: TransitionAndEmitOptions<T>,
): WorkflowState {
  const { state, projectDir, sessionId, callbacks, action, eventName, status, emitData } = opts;
  const next = transitionAndSave(projectDir, sessionId, state, action);
  if (status) {
    emitPlannerStatus(callbacks, next, status);
  }
  emit(projectDir, sessionId, next, eventName, undefined, emitData);
  return next;
}

async function regeneratePlan(projectDir: string, sessionId: string, planner: Planner, callbacks: OrchestratorCallbacks, state: WorkflowState, metadata: SpecMetadata, skillsContext?: string): Promise<{ state: WorkflowState; plan: string }> {
  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const result = await runPlannerReview({
    planner,
    prompt: buildPlanPromptFromSpec(spec, projectContext, skillsContext),
    projectDir,
    sessionId,
    callbacks,
    state,
    metadata,
    writeTo: PLAN_FILE,
  });
  return { state: result.state, plan: result.text };
}

async function regenerateTasks(projectDir: string, sessionId: string, planner: Planner, callbacks: OrchestratorCallbacks, state: WorkflowState, metadata: SpecMetadata, planOverride?: string): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const plan = planOverride ?? readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
  const result = await runPlannerReview({
    planner,
    prompt: buildTasksPrompt(spec, plan),
    projectDir,
    sessionId,
    callbacks,
    state,
    metadata,
    writeTo: TASKS_FILE,
  });
  return { state: result.state, tasks: parseTasks(result.text) };
}

async function regeneratePlanAndTasks(
  projectDir: string, sessionId: string, planner: Planner, callbacks: OrchestratorCallbacks, state: WorkflowState, metadata: SpecMetadata, skillsContext?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const planRegen = await regeneratePlan(projectDir, sessionId, planner, callbacks, state, metadata, skillsContext);
  const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, planRegen.state, metadata, planRegen.plan);
  return { state: taskRegen.state, tasks: taskRegen.tasks };
}

async function runQuickPlanning(opts: PlanningPhaseOptions): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const { wctx, feature, planner } = opts;
  const { projectDir, sessionId, config, callbacks, metadata } = wctx;
  let { state } = opts;

  let planResult: Awaited<ReturnType<Planner['plan']>>;
  try {
    const quickPlanFn = planner.quickPlan ?? planner.plan;
    planResult = await quickPlanFn.call(planner, feature, projectDir, {
      onOutput: createTextHandler(callbacks),
      sessionId,
      persistTranscript: config.workflow.persistTranscript,
    });
  } catch (err) {
    return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, callbacks);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_QUICK', tasks: planResult.tasks });
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, sessionId, state, 'plan_approved', undefined, {});

  return { state, tasks: planResult.tasks, cancelled: false };
}

async function runFullPlanning(opts: PlanningPhaseOptions, skipPlanApproval: boolean): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const { wctx, feature, planner, selectedSkills } = opts;
  const { projectDir, sessionId, config, callbacks, metadata } = wctx;
  const signal = wctx.signal;
  let { state } = opts;
  const collectedQuestions: ClarificationQuestion[] = [];
  const conversational = planner.capabilities.supportsConversationalPlanning;
  const skillsContext = selectedSkills?.length ? await buildSkillsSection(selectedSkills) : undefined;

  let planResult: Awaited<ReturnType<Planner['plan']>>;
  try {
    planResult = await planner.plan(feature, projectDir, {
      onOutput: createTextHandler(callbacks),
      onQuestion: conversational ? (questions) => {
        for (const q of questions) {
          if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
            collectedQuestions.push(q);
          }
        }
      } : undefined,
      sessionId,
      persistTranscript: config.workflow.persistTranscript,
    }, skillsContext);
  } catch (err) {
    return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  let tasks = planResult.tasks;

  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, callbacks);

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'RESEARCH_DONE' }, eventName: 'research_done', emitData: {} });

  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    await collectAndPersistClarifications(collectedQuestions, projectDir, sessionId, state, callbacks.onQuestionAsked, config.workflow.persistTranscript, metadata);
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

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running', emitData: {} });

  return { state, tasks, cancelled: false };
}

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const mode = opts.wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;

  if (mode === 'quick') {
    return runQuickPlanning(opts);
  }

  const skipPlanApproval = mode === 'standard';
  return runFullPlanning(opts, skipPlanApproval);
}
