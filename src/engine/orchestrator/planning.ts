import { join } from 'node:path';
import type { OrchestratorCallbacks, WorkflowState, Task, SkillMeta, StateAction, ClarificationQuestion } from '../../types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../types.js';
import type { OrchestratorEventPayloadMap } from '../../core/types/events.js';
import type { PlannerCallbacksContext } from './types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { parseTasks } from '../spec/parser.js';
import { buildPlanPromptFromSpec, buildRegeneratePrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildSkillsSection } from '../skills/index.js';
import type { Planner, PlanResult } from '../planners/types.js';
import { buildProjectContextMarkdown } from '../planners/context.js';
import { emit, createTextHandler, emitError, emitWarning, emitPlannerStatus } from './events.js';
import { addUsageAndSave, transitionAndSave, runPlannerReview } from './helpers.js';
import { labelError } from '../../utils/format.js';
import { appendMessage } from '../../core/state/persistence.js';
import { collectAndPersistClarifications } from './clarifications.js';
import { runApprovalLoop } from './approval.js';
import { buildResumeContext } from './transcript-rebuild.js';
import { buildContinuationPrompt } from './continuation.js';
import { workflowStore } from '../../stores/workflow.js';
import { drainQueue, formatDrainedMessages } from './queue-drain.js';

const MAX_CLARIFICATION_QUESTIONS = 5;

/** Drain pending queue messages and format them as a prompt prefix. Returns updated state and prefix string. */
function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  callbacks: OrchestratorCallbacks,
): { state: WorkflowState; prefix: string } {
  const drain = drainQueue(projectDir, sessionId, state, callbacks);
  if (drain.messages.length === 0) return { state, prefix: '' };
  return { state: drain.state, prefix: formatDrainedMessages(drain.messages) };
}

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
  rewindPending?: { target: 'spec' | 'plan'; comment?: string | undefined } | undefined;
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
  const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
  state = drainedState;
  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const basePrompt = buildPlanPromptFromSpec(spec, projectContext, skillsContext);
  const result = await runPlannerReview({
    planner,
    prompt: prefix ? prefix + basePrompt : basePrompt,
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
  const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
  state = drainedState;
  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const plan = planOverride ?? readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
  const basePrompt = buildTasksPrompt(spec, plan);
  const result = await runPlannerReview({
    planner,
    prompt: prefix ? prefix + basePrompt : basePrompt,
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
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks, metadata, resumeHolder } = wctx;
  const signal = wctx.signal;
  let { state } = opts;
  let feature = opts.feature;
  let partialOutput = '';

  // Drain any queued messages before the planner call so the planner sees them.
  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    if (prefix) feature = prefix + feature;
  }

  let planResult: Awaited<ReturnType<Planner['plan']>>;

  // Per-call abort + continuation loop (mirrors task-step.ts)
  while (true) {
    const callController = new AbortController();
    workflowStore.setAbortHandler(() => callController.abort());
    partialOutput = '';
    const textHandler = createTextHandler(callbacks);

    try {
      const quickPlanFn = planner.quickPlan ?? planner.plan;
      planResult = await quickPlanFn.call(planner, feature, projectDir, {
        onOutput: (text) => { partialOutput += text; textHandler(text); },
        onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
        onSessionExpired: async () => {
          emitWarning(callbacks, 'Previous planner conversation expired — rebuilding context from transcript.');
          const rebuilt = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript !== false);
          if (rebuilt.warning === 'transcript-unavailable') {
            emitWarning(callbacks, 'Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.');
          } else if (resumeHolder) {
            resumeHolder.messages = rebuilt.messages;
          }
        },
        sessionId,
        persistTranscript: config.workflow.persistTranscript,
        ...(resumeHolder && resumeHolder.messages.length > 0 ? { priorMessages: resumeHolder.messages } : {}),
      });
    } catch (err) {
      workflowStore.setAbortHandler(null);

      // Per-call abort (not workflow cancel): enter continuation mode
      if (callController.signal.aborted && !signal?.aborted && callbacks.onContinuationNeeded) {
        state = transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' });
        const userText = await callbacks.onContinuationNeeded(partialOutput);
        state = transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' });
        feature = buildContinuationPrompt(partialOutput, userText);
        continue;
      }

      return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
    }

    workflowStore.setAbortHandler(null);
    break;
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, callbacks);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_QUICK', tasks: planResult.tasks });
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, sessionId, state, 'plan_approved', undefined, {});

  return { state, tasks: planResult.tasks, cancelled: false };
}

async function runFullPlanning(opts: PlanningPhaseOptions, skipPlanApproval: boolean): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const { wctx, planner, selectedSkills } = opts;
  const { projectDir, sessionId, config, callbacks, metadata, resumeHolder } = wctx;
  const signal = wctx.signal;
  let { state } = opts;
  const conversational = planner.capabilities.supportsConversationalPlanning;
  const skillsContext = selectedSkills?.length ? await buildSkillsSection(selectedSkills) : undefined;
  let feature = opts.feature;
  let partialOutput = '';

  // Rewind fast-path: skip full planner.plan() call and directly regenerate the target artifact.
  const rewindPending = opts.rewindPending;
  if (rewindPending) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'CLEAR_REWIND_PENDING' });

    if (rewindPending.target === 'spec') {
      // Regenerate spec (with comment if provided), then go through spec/plan/tasks flow.
      if (rewindPending.comment) {
        appendMessage(projectDir, sessionId, { role: 'user', phase: 'specifying', text: rewindPending.comment }, config.workflow.persistTranscript);
        const current = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
        const { state: drainedState, prefix: drainPrefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
        state = drainedState;
        const regenPromptBase = buildRegeneratePrompt('spec', current, rewindPending.comment);
        const regenPrompt = drainPrefix ? drainPrefix + regenPromptBase : regenPromptBase;
        createTextHandler(callbacks)(`\n[Regenerating spec with feedback: ${rewindPending.comment}]\n`);
        const regenResult = await planner.regenerate(regenPrompt, 'spec', projectDir, {
          onOutput: createTextHandler(callbacks),
        });
        state = addUsageAndSave(projectDir, sessionId, state, 'planner', regenResult.usage, callbacks);
        writeSpecFile(projectDir, sessionId, SPEC_FILE, regenResult.text, metadata);
        emit(projectDir, sessionId, state, 'spec_regenerated', undefined, { comment: rewindPending.comment });
      }

      state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'SPEC_DONE' }, eventName: 'spec_done', status: 'running', emitData: {} });

      const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
      if (!config.workflow.autoApproveSpec) {
        const specLoop = await runApprovalLoop({ type: 'spec', filePath: specPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
        state = specLoop.state;
        if (specLoop.rejected) return { state, tasks: [], cancelled: true };
      }

      state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_SPEC' }, eventName: 'spec_approved', status: 'running', emitData: {} });

      const { state: planAndTasksState, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, state, metadata, skillsContext);
      state = planAndTasksState;

      state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'PLAN_DONE', tasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: tasks.length } });

      const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
      if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
        const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
        state = planLoop.state;
        if (planLoop.rejected) return { state, tasks: [], cancelled: true };
        if (planLoop.regenerated) {
          const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
          state = taskRegen.state;
          return { state: transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running', emitData: {} }), tasks: taskRegen.tasks, cancelled: false };
        }
      }

      state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running', emitData: {} });
      return { state, tasks, cancelled: false };
    }

    // rewindPending.target === 'plan': regenerate plan (spec preserved), then go through plan/tasks flow.
    if (rewindPending.comment) {
      appendMessage(projectDir, sessionId, { role: 'user', phase: 'planning', text: rewindPending.comment }, config.workflow.persistTranscript);
      const current = readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
      const { state: drainedState, prefix: drainPrefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
      state = drainedState;
      const regenPromptBase = buildRegeneratePrompt('plan', current, rewindPending.comment);
      const regenPrompt = drainPrefix ? drainPrefix + regenPromptBase : regenPromptBase;
      createTextHandler(callbacks)(`\n[Regenerating plan with feedback: ${rewindPending.comment}]\n`);
      const regenResult = await planner.regenerate(regenPrompt, 'plan', projectDir, {
        onOutput: createTextHandler(callbacks),
      });
      state = addUsageAndSave(projectDir, sessionId, state, 'planner', regenResult.usage, callbacks);
      writeSpecFile(projectDir, sessionId, PLAN_FILE, regenResult.text, metadata);
      emit(projectDir, sessionId, state, 'plan_regenerated', undefined, { comment: rewindPending.comment });
    }

    const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
    state = taskRegen.state;
    const rewindTasks = taskRegen.tasks;

    state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'PLAN_DONE', tasks: rewindTasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: rewindTasks.length } });

    const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
    if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
      const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
      state = planLoop.state;
      if (planLoop.rejected) return { state, tasks: [], cancelled: true };
      if (planLoop.regenerated) {
        const taskRegen2 = await regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
        state = taskRegen2.state;
        return { state: transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running', emitData: {} }), tasks: taskRegen2.tasks, cancelled: false };
      }
    }

    state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running', emitData: {} });
    return { state, tasks: rewindTasks, cancelled: false };
  }

  const collectedQuestions: ClarificationQuestion[] = [];

  // Drain any queued messages before the primary planner.plan() call so the planner sees them.
  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    if (prefix) feature = prefix + feature;
  }

  let planResult: Awaited<ReturnType<Planner['plan']>>;

  // Per-call abort + continuation loop (mirrors task-step.ts)
  while (true) {
    const callController = new AbortController();
    workflowStore.setAbortHandler(() => callController.abort());
    partialOutput = '';
    const textHandler = createTextHandler(callbacks);

    try {
      planResult = await planner.plan(feature, projectDir, {
        onOutput: (text) => { partialOutput += text; textHandler(text); },
        onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
        onSessionExpired: async () => {
          emitWarning(callbacks, 'Previous planner conversation expired — rebuilding context from transcript.');
          const rebuilt = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript !== false);
          if (rebuilt.warning === 'transcript-unavailable') {
            emitWarning(callbacks, 'Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.');
          } else if (resumeHolder) {
            resumeHolder.messages = rebuilt.messages;
          }
        },
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
    } catch (err) {
      workflowStore.setAbortHandler(null);

      // Per-call abort (not workflow cancel): enter continuation mode
      if (callController.signal.aborted && !signal?.aborted && callbacks.onContinuationNeeded) {
        state = transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' });
        const userText = await callbacks.onContinuationNeeded(partialOutput);
        state = transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' });
        feature = buildContinuationPrompt(partialOutput, userText);
        continue;
      }

      return handlePlanningFailure(err, projectDir, sessionId, state, callbacks);
    }

    workflowStore.setAbortHandler(null);
    break;
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
