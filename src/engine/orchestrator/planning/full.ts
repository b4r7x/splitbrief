import { join } from 'node:path';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { PlanResult } from '../../planners/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { saveState } from '../../../core/state/persistence.js';
import { getPlannerToolId } from '../../../core/config/accessors/runner-config.js';
import { parseDiscoveredValidation } from './parse-validation.js';
import { buildSkillsSection, discoverSkills } from '../../skill-discovery.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { publishPlannerStatus } from '../events.js';
import { collectAndPersistClarifications } from '../clarifications.js';
import { runApprovalLoop } from '../approval/loop.js';
import {
  blocksSpecGate,
  blocksPlanGate,
  resolveApproveLevel,
} from '../../../core/config/runtime/resolve.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import { handleRewindSpec, handleRewindPlan } from './rewind.js';
import { resetDriftChainState } from '../drift/chain-state.js';
import { drainAndFormat } from './queue-drain.js';
import { handlePlanningFailure } from './failure.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import { regenerateTasks, regeneratePlanAndTasks } from './regen.js';
import type { PlanningPhaseOptions, PlanningPhaseResult, PlanningRunContext } from './types.js';

async function resolvePlanningSkills(
  selectedSkills: SkillMeta[] | undefined,
  state: WorkflowState,
  projectDir: string,
  config: Config,
): Promise<SkillMeta[]> {
  if (selectedSkills && selectedSkills.length > 0) return selectedSkills;
  const persisted = state.selectedSkills;
  if (!persisted || persisted.length === 0) return [];
  const ids = new Set(persisted);
  const available = await discoverSkills(getPlannerToolId(config.planner), projectDir);
  return available.filter((s) => ids.has(s.id));
}

async function runNewPlanning(
  opts: PlanningPhaseOptions,
  ctx: PlanningRunContext,
): Promise<PlanningPhaseResult> {
  const { approveLevel, metadata, skillsContext } = ctx;
  let state = ctx.state;
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
      ...(resumeHolder && resumeHolder.messages.length > 0
        ? { priorMessages: resumeHolder.messages }
        : {}),
      ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      collectedQuestions,
      phaseHint: 'analyzing codebase',
    });
    state = run.state;
    planResult = run.result;
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }

  persistPhases(projectDir, sessionId, planResult.phases, metadata);
  let tasks = planResult.tasks;

  const researchPhase = planResult.phases?.[0];
  if (researchPhase) {
    const discovered = parseDiscoveredValidation(researchPhase.text);
    if (discovered) {
      state = { ...state, discoveredValidation: discovered };
      saveState({ projectDir, sessionId }, state);
    }
  }

  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'RESEARCH_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    state = await collectAndPersistClarifications({
      questions: collectedQuestions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked: callbacks.onQuestionAsked,
      persistTranscript: config.workflow.persistTranscript,
      bus: wctx.bus,
      metadata,
      planner,
    });
    ({ state, tasks } = await regeneratePlanAndTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus: wctx.bus,
      state,
      metadata,
      skillsContext,
      signal,
      sinks: wctx.sinks,
    }));
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'SPEC_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);

  if (blocksSpecGate(approveLevel)) {
    const specLoop = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      signal,
      persistTranscript: config.workflow.persistTranscript,
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = specLoop.state;
    if (specLoop.rejected || specLoop.aborted) return { state, tasks: [], cancelled: true };
    if (specLoop.regenerated) {
      ({ state, tasks } = await regeneratePlanAndTasks({
        projectDir,
        sessionId,
        planner,
        callbacks,
        bus: wctx.bus,
        state,
        metadata,
        skillsContext,
        signal,
        sinks: wctx.sinks,
      }));
    }
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_SPEC' });
  publishPlannerStatus(wctx.bus, state, 'running');

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'PLAN_DONE', tasks });
  publishPlannerStatus(wctx.bus, state, 'running');

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);

  if (blocksPlanGate(approveLevel)) {
    const planLoop = await runApprovalLoop({
      type: 'plan',
      filePath: planPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      signal,
      persistTranscript: config.workflow.persistTranscript,
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = planLoop.state;
    if (planLoop.rejected || planLoop.aborted) return { state, tasks: [], cancelled: true };
    if (planLoop.regenerated) {
      const taskRegen = await regenerateTasks({
        projectDir,
        sessionId,
        planner,
        callbacks,
        bus: wctx.bus,
        state,
        metadata,
        signal,
        sinks: wctx.sinks,
      });
      state = taskRegen.state;
      tasks = taskRegen.tasks;
    }
  }

  runBriefQualityGate({ tasks, projectDir, sessionId, bus: wctx.bus, phase: state.phase });

  if (!opts.deferBriefGate) {
    const briefsLoop = await runBriefsApprovalLoop({
      tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      config,
      metadata,
      signal,
      sinks: wctx.sinks,
    });
    state = briefsLoop.state;
    tasks = briefsLoop.tasks;
    if (briefsLoop.rejected || briefsLoop.aborted) return { state, tasks: [], cancelled: true };

    publishPlannerStatus(wctx.bus, state, 'running');
    wctx.bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });
  }

  return { state, tasks, cancelled: false };
}

export async function runFullPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, selectedSkills } = opts;
  const { projectDir, sessionId, metadata, config } = wctx;
  let { state } = opts;
  const skills = await resolvePlanningSkills(selectedSkills, state, projectDir, config);
  const skillsContext = skills.length > 0 ? await buildSkillsSection(skills) : undefined;

  const approveLevel =
    opts.approveLevel ??
    resolveApproveLevel({
      mode: getWorkflowMode(config),
      configApprove: config.workflow.approve,
      legacyAutoFlag:
        config.workflow.autoApproveSpec === true && config.workflow.autoApprovePlan === true,
    });
  const skipSpecApproval = !blocksSpecGate(approveLevel);
  const skipPlanApproval = !blocksPlanGate(approveLevel);

  const rewindPending = opts.rewindPending;
  if (rewindPending) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CLEAR_REWIND_PENDING' });
    try {
      resetDriftChainState(projectDir, sessionId);
    } catch {
      // non-fatal: rewind continues even if chain state reset fails
    }
    if (rewindPending.target === 'spec') {
      return handleRewindSpec({
        opts,
        rewindPending,
        skipSpecApproval,
        skipPlanApproval,
        metadata,
        skillsContext,
        state,
      });
    }
    return handleRewindPlan({ opts, rewindPending, skipPlanApproval, metadata, state });
  }

  return runNewPlanning(opts, { approveLevel, metadata, skillsContext, state });
}
