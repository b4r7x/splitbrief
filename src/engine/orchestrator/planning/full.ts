import { join } from 'node:path';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { PlanResult } from '../../planners/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { parseDiscoveredValidation } from './parse-validation.js';
import { sanitizeDiscoveredValidation } from './sanitize-discovered-validation.js';
import { buildSkillsSection, discoverSkills } from '../../skill-discovery.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
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
import { persistPhases } from './io.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import { regenerateTasks, regeneratePlanAndTasks } from './regen.js';
import type { PlanningPhaseOptions, PlanningPhaseResult, PlanningRunContext } from './types.js';
import { parkedResult } from './brief-quality-preparation.js';
import { fallbackBriefRecoveryProjection } from './brief-quality-queue.js';
import { isRecord } from '../../../utils/type-guards.js';

function compilerFailureCode(err: unknown): string | null {
  if (!isRecord(err)) return null;
  const kind = err.kind;
  return typeof kind === 'string' && kind.startsWith('task_compiler_') ? kind : null;
}

function compilerBlockerProjection(
  base: BriefRecoveryProjectionV1,
  code: string,
): BriefRecoveryProjectionV1 {
  return {
    ...base,
    status: 'blocked',
    blocker: { kind: 'provider', code, message: `Task Brief compilation failed: ${code}` },
    allowedActions: ['retry', 'edit', 'reject'],
  };
}

export function isCompilerFailureProjection(projection: BriefRecoveryProjectionV1): boolean {
  return (
    projection.blocker?.kind === 'provider' && projection.blocker.code.startsWith('task_compiler_')
  );
}

function parkCompilerFailure(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
  code: string,
  err: unknown,
): PlanningPhaseResult {
  const detail = err instanceof Error ? err.message : String(err);
  publishWarning({
    bus: opts.wctx.bus,
    phase: state.phase,
    message: `Task Brief compilation failed (${code}): ${detail}`,
    safety: { category: 'planning', code, transcriptSafe: true },
  });
  return {
    disposition: 'parked',
    state,
    projection: compilerBlockerProjection(
      opts.recovery?.projection ?? fallbackBriefRecoveryProjection(opts.wctx.sessionId, state),
      code,
    ),
  };
}

async function resolvePlanningSkills(
  selectedSkills: SkillMeta[] | undefined,
  state: WorkflowState,
  projectDir: string,
): Promise<SkillMeta[]> {
  if (selectedSkills && selectedSkills.length > 0) return selectedSkills;
  const persisted = state.selectedSkills;
  if (!persisted || persisted.length === 0) return [];
  const ids = new Set(persisted);
  const available = await discoverSkills(projectDir);
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
    const compilerCode = compilerFailureCode(err);
    if (compilerCode !== null) return parkCompilerFailure(opts, state, compilerCode, err);
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }

  // Fixed tasks.md is a compatibility projection that may be refreshed only
  // after the authoritative generation commit; the initial planning pass
  // persists the research/spec/plan phases and leaves task-brief phases to the
  // owner publication path.
  persistPhases({
    projectDir,
    sessionId,
    phases: planResult.phases?.filter((phase) => phase.artifact.logicalName !== TASKS_FILE),
    metadata,
    bus: wctx.bus,
    phase: state.phase,
  });
  let tasks = planResult.tasks;

  const researchPhase = planResult.phases?.[0];
  if (researchPhase) {
    const discovered = sanitizeDiscoveredValidation(
      parseDiscoveredValidation(researchPhase.artifact.text),
    );
    if (discovered) {
      state = { ...state, discoveredValidation: discovered };
    }
  }

  state = addUsageAndSave(wctx, state, 'planner', planResult.usage);

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'RESEARCH_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  if (collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
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
    if (specLoop.rejected || specLoop.aborted)
      return { disposition: 'terminal', state, outcome: 'rejected' };
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

  if (opts.afterSpecReview) {
    const advanced = await opts.afterSpecReview({ state, tasks });
    state = advanced.state;
    tasks = advanced.tasks;
    if (advanced.cancelled) return { disposition: 'terminal', state, outcome: 'cancelled' };
  } else {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_SPEC' });
    publishPlannerStatus(wctx.bus, state, 'running');
  }

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
    if (planLoop.rejected || planLoop.aborted)
      return { disposition: 'terminal', state, outcome: 'rejected' };
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

  return parkedResult({ recovery: opts.recovery, sessionId, state: { ...state, tasks } });
}

export async function runFullPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, selectedSkills } = opts;
  const { projectDir, sessionId, metadata, config } = wctx;
  let { state } = opts;
  const skills = await resolvePlanningSkills(selectedSkills, state, projectDir);
  const skillsContext = skills.length > 0 ? await buildSkillsSection(skills) : undefined;

  const approveLevel =
    opts.approveLevel ??
    resolveApproveLevel({
      mode: getWorkflowMode(config),
      configApprove: config.workflow.approve,
    });
  const skipSpecApproval = !blocksSpecGate(approveLevel);
  const skipPlanApproval = !blocksPlanGate(approveLevel);

  const rewindPending = opts.rewindPending;
  if (rewindPending) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CLEAR_REWIND_PENDING' });
    try {
      resetDriftChainState({ projectDir, sessionId });
    } catch {
      // non-fatal: rewind continues even if chain state reset fails
    }
    if (opts.recovery === undefined) {
      return parkedResult({ recovery: opts.recovery, sessionId, state });
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
        recovery: opts.recovery,
      });
    }
    return handleRewindPlan({
      opts,
      rewindPending,
      skipPlanApproval,
      metadata,
      state,
      recovery: opts.recovery,
    });
  }

  return runNewPlanning(opts, { approveLevel, metadata, skillsContext, state });
}
