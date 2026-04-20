import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { PlanResult } from '../../planners/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildSkillsSection } from '../../skills/discovery.js';
import { addUsageAndSave, transitionAndSave, publishPlanApproved } from '../state-ops.js';
import { publishPlannerStatus } from '../events.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { runApprovalLoop } from '../approval.js';
import { blocksSpecGate, blocksPlanGate, resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { handleRewindSpec, handleRewindPlan } from './rewind.js';
import {
  drainAndFormat,
  handlePlanningFailure,
  persistPhases,
  regenerateTasks,
  regeneratePlanAndTasks,
  runPlannerCallInContinuationLoop,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';

async function runNewPlanning(
  opts: PlanningPhaseOptions,
  approveLevel: ApproveLevel,
  metadata: SpecMetadata,
  skillsContext: string | undefined,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder } = wctx;
  const signal = wctx.signal;
  const conversational = planner.capabilities.supportsConversationalPlanning;
  let feature = opts.feature;
  const collectedQuestions: ClarificationQuestion[] = [];

  {
    const { state: drainedState, prefix } = drainAndFormat(projectDir, sessionId, state, wctx.bus);
    state = drainedState;
    feature = prefix + feature;
  }

  let planResult: PlanResult;
  try {
    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state,
      planner,
      feature,
      mode: 'speckit',
      skillsContext,
      ...(opts.codebaseContext !== undefined ? { codebaseContext: opts.codebaseContext } : {}),
      ...(resumeHolder && resumeHolder.messages.length > 0 ? { priorMessages: resumeHolder.messages } : {}),
      ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      collectedQuestions,
    });
    state = run.state;
    planResult = run.result;
  } catch (err) {
    return handlePlanningFailure(err, projectDir, sessionId, state, wctx);
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  let tasks = planResult.tasks;

  state = addUsageAndSave(projectDir, sessionId, state, 'planner', planResult.usage, wctx.bus);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'RESEARCH_DONE' });

  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications(collectedQuestions, projectDir, sessionId, state, callbacks.onQuestionAsked, config.workflow.persistTranscript, wctx.bus, metadata, planner);
    ({ state, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, wctx.bus, state, metadata, skillsContext));
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);

  if (blocksSpecGate(approveLevel)) {
    const specLoop = await runApprovalLoop({ type: 'spec', filePath: specPath, planner, projectDir, sessionId, callbacks, bus: wctx.bus, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = specLoop.state;
    if (specLoop.rejected) return { state, tasks: [], cancelled: true };
    if (specLoop.regenerated) {
      ({ state, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, wctx.bus, state, metadata, skillsContext));
    }
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'APPROVE_SPEC' });
  publishPlannerStatus(wctx.bus, state, 'running');

  state = transitionAndSave(projectDir, sessionId, state, { type: 'PLAN_DONE', tasks });
  publishPlannerStatus(wctx.bus, state, 'running');

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);

  if (blocksPlanGate(approveLevel)) {
    const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, bus: wctx.bus, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
    if (planLoop.regenerated) {
      const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, wctx.bus, state, metadata);
      state = taskRegen.state;
      tasks = taskRegen.tasks;
    }
  }

  state = publishPlanApproved(state, { projectDir, sessionId, bus: wctx.bus });

  return { state, tasks, cancelled: false };
}

export async function runFullPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, selectedSkills } = opts;
  const { projectDir, sessionId, metadata, config } = wctx;
  let { state } = opts;
  const skillsContext = selectedSkills?.length ? await buildSkillsSection(selectedSkills) : undefined;

  const approveLevel = opts.approveLevel ?? resolveApproveLevel({
    mode: config.workflow.mode ?? 'standard',
    configApprove: config.workflow.approve,
  });
  const skipPlanApproval = !blocksPlanGate(approveLevel);

  const rewindPending = opts.rewindPending;
  if (rewindPending) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'CLEAR_REWIND_PENDING' });
    if (rewindPending.target === 'spec') {
      return handleRewindSpec(opts, rewindPending, skipPlanApproval, metadata, skillsContext, state);
    }
    return handleRewindPlan(opts, rewindPending, skipPlanApproval, metadata, state);
  }

  return runNewPlanning(opts, approveLevel, metadata, skillsContext, state);
}
