import { join } from 'node:path';
import type { Config, WorkflowState, Task, OrchestratorCallbacks, SkillMeta, StateAction, OrchestratorEventType } from '../../types.js';
import { transition } from '../../core/state.js';
import { saveState } from '../../core/state-persistence.js';
import { readSpecFile, writeSpecFile } from '../../utils/fs.js';
import { buildRegeneratePrompt } from '../spec/planning-prompts.js';
import { buildSkillsSection } from '../skills.js';
import type { ClarificationQuestion } from '../question-parser.js';
import type { PlannerBackend } from '../planners/types.js';
import { supportsConversational } from '../planners/base.js';

import { emit, createTextHandler } from './events.js';
import { addUsageAndSave } from './helpers.js';
import { toErrorMessage } from '../../utils/format.js';

type TransitionAndEmitOptions = {
  state: WorkflowState;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  action: StateAction;
  eventName: OrchestratorEventType;
  status?: 'running' | 'done';
  emitData?: Record<string, unknown>;
};

function transitionAndEmit(opts: TransitionAndEmitOptions): WorkflowState {
  const { state, projectDir, callbacks, action, eventName, status, emitData } = opts;
  const next = transition(state, action);
  saveState(projectDir, next);
  if (status) {
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: next.phase, status });
  }
  emit(projectDir, next, eventName, undefined, emitData);
  return next;
}

type ApprovalLoopOptions = {
  type: 'spec' | 'plan';
  filePath: string;
  planner: PlannerBackend;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
};

async function runApprovalLoop(opts: ApprovalLoopOptions): Promise<{ state: WorkflowState; rejected: boolean }> {
  const { type, filePath, planner, projectDir, callbacks } = opts;
  let { state } = opts;
  const rejectType = type === 'spec' ? 'REJECT_SPEC' : 'REJECT_PLAN';
  const eventName: 'spec' | 'plan' = type === 'spec' ? 'spec' : 'plan';
  const rejectedEvent: OrchestratorEventType = type === 'spec' ? 'spec_rejected' : 'plan_rejected';
  const regeneratedEvent: OrchestratorEventType = type === 'spec' ? 'spec_regenerated' : 'plan_regenerated';
  const filename = `${eventName}.md`;

  while (true) {
    const result = await callbacks.onApprovalNeeded(type, filePath);
    if (!result.approved && !result.comment) {
      state = transition(state, { type: rejectType });
      saveState(projectDir, state);
      callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done' });
      emit(projectDir, state, rejectedEvent);
      return { state, rejected: true };
    }
    if (result.comment) {
      const current = readSpecFile(projectDir, filename) ?? '';
      const regenPrompt = buildRegeneratePrompt(type, current, result.comment);
      callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: `\n[Regenerating ${eventName} with feedback: ${result.comment}]\n` });
      const regenResult = await planner.regenerate(regenPrompt, type, projectDir, {
        onOutput: createTextHandler(callbacks),
      });
      state = addUsageAndSave(projectDir, state, 'planner', regenResult.usage, callbacks);
      emit(projectDir, state, regeneratedEvent, undefined, { comment: result.comment });
      continue;
    }
    break;
  }

  return { state, rejected: false };
}

async function collectAndPersistClarifications(
  questions: ClarificationQuestion[],
  projectDir: string,
  state: WorkflowState,
  onQuestionAsked: NonNullable<OrchestratorCallbacks['onQuestionAsked']>,
): Promise<void> {
  const clarifications: Array<{ question: string; answer: string }> = [];
  const total = questions.length;

  for (let qi = 0; qi < total; qi++) {
    const question = questions[qi];
    const answer = await onQuestionAsked(question, qi + 1, total);

    if (answer === 'done') break;
    if (answer === 'skip' || answer === '') continue;

    clarifications.push({ question: question.text, answer });
  }

  if (clarifications.length === 0) return;

  let content = readSpecFile(projectDir, 'spec.md') ?? '';
  const sessionHeader = `### Session ${new Date().toISOString().slice(0, 10)}`;
  const entries = clarifications.map(c => `- Q: ${c.question} \u2192 A: ${c.answer}`).join('\n');

  if (!content.includes('## Clarifications')) {
    content += `\n\n## Clarifications\n\n${sessionHeader}\n${entries}\n`;
  } else if (!content.includes(sessionHeader)) {
    content += `\n${sessionHeader}\n${entries}\n`;
  } else {
    content += `\n${entries}\n`;
  }

  writeSpecFile(projectDir, 'spec.md', content);
  emit(projectDir, state, 'clarifications_collected', undefined, {
    count: clarifications.length,
    clarifications,
  });
}

type PlanningPhaseOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  planner: PlannerBackend;
  state: WorkflowState;
  selectedSkills?: SkillMeta[];
};

async function runQuickPlanning(opts: PlanningPhaseOptions): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const { feature, projectDir, callbacks, planner, config } = opts;
  let { state } = opts;

  let planResult: Awaited<ReturnType<PlannerBackend['plan']>>;
  try {
    const quickPlanFn = planner.quickPlan ?? planner.plan;
    planResult = await quickPlanFn.call(planner, feature, projectDir, config, {
      onOutput: createTextHandler(callbacks),
    });
  } catch (err) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Planning failed: ${toErrorMessage(err)}` });
    state = transition(state, { type: 'CANCEL' });
    saveState(projectDir, state);
    return { state, tasks: [], cancelled: true };
  }

  state = addUsageAndSave(projectDir, state, 'planner', planResult.usage, callbacks);

  state = transition(state, { type: 'START_QUICK', tasks: planResult.tasks });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(projectDir, state, 'plan_approved');

  return { state, tasks: planResult.tasks, cancelled: false };
}

async function runFullPlanning(opts: PlanningPhaseOptions, skipPlanApproval: boolean): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const { feature, projectDir, config, callbacks, planner, selectedSkills } = opts;
  let { state } = opts;
  const MAX_CLARIFICATION_QUESTIONS = 5;
  const collectedQuestions: ClarificationQuestion[] = [];
  const conversational = supportsConversational(config.planner.tool);

  let planResult: Awaited<ReturnType<PlannerBackend['plan']>>;
  try {
    const skillsContext = selectedSkills?.length ? buildSkillsSection(selectedSkills) : undefined;

    planResult = await planner.plan(feature, projectDir, config, {
      onOutput: createTextHandler(callbacks),
      onQuestion: conversational ? (questions) => {
        for (const q of questions) {
          if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
            collectedQuestions.push(q);
          }
        }
      } : undefined,
    }, skillsContext);
  } catch (err) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Planning failed: ${toErrorMessage(err)}` });
    state = transition(state, { type: 'CANCEL' });
    saveState(projectDir, state);
    return { state, tasks: [], cancelled: true };
  }

  const { tasks } = planResult;

  state = addUsageAndSave(projectDir, state, 'planner', planResult.usage, callbacks);

  state = transitionAndEmit({ state, projectDir, callbacks, action: { type: 'RESEARCH_DONE' }, eventName: 'research_done' });

  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    await collectAndPersistClarifications(collectedQuestions, projectDir, state, callbacks.onQuestionAsked);
  }

  state = transitionAndEmit({ state, projectDir, callbacks, action: { type: 'SPEC_DONE' }, eventName: 'spec_done', status: 'running' });

  const specPath = join(projectDir, '.tiny-spec', 'current', 'spec.md');

  if (!config.workflow.autoApproveSpec) {
    const specLoop = await runApprovalLoop({ type: 'spec', filePath: specPath, planner, projectDir, callbacks, state });
    state = specLoop.state;
    if (specLoop.rejected) return { state, tasks: [], cancelled: true };
  }

  state = transitionAndEmit({ state, projectDir, callbacks, action: { type: 'APPROVE_SPEC' }, eventName: 'spec_approved', status: 'running' });

  state = transitionAndEmit({ state, projectDir, callbacks, action: { type: 'PLAN_DONE', tasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: tasks.length } });

  const planPath = join(projectDir, '.tiny-spec', 'current', 'plan.md');

  if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
    const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, callbacks, state });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
  }

  state = transitionAndEmit({ state, projectDir, callbacks, action: { type: 'APPROVE_PLAN' }, eventName: 'plan_approved', status: 'running' });

  return { state, tasks, cancelled: false };
}

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<{ state: WorkflowState; tasks: Task[]; cancelled: boolean }> {
  const mode = opts.config.workflow.mode ?? 'standard';

  if (mode === 'quick') {
    return runQuickPlanning(opts);
  }

  const skipPlanApproval = mode === 'standard';
  return runFullPlanning(opts, skipPlanApproval);
}
