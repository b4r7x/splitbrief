import type { BriefQualityReport } from '../../spec/brief-quality.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryCommand,
  BriefRecoveryProjectionV1,
  PlannerAttemptSettlement,
} from '../../../core/schemas/brief-recovery.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { PlanningPhaseResult } from './types.js';
import { handlePlanningFailure } from './failure.js';
import { planningError } from './errors.js';
import {
  briefQualityReportFromProjection,
  prepareBriefQuality,
  fallbackBriefRecoveryProjection,
  type BriefQualityPreparationOptions,
  type BriefQualityControllerResult,
  type BriefQualityRecoveryBinding,
} from './brief-quality-preparation.js';

type PreparationOptions = BriefQualityPreparationOptions;

export type BriefQualityRunOptions = Pick<PreparationOptions, 'tasks' | 'state' | 'planner'> & {
  wctx: PlannerCallbacksContext;
  queuedMessages?: PreparationOptions['queuedMessages'];
  recovery?: BriefQualityRecoveryBinding | undefined;
  action?: BriefRecoveryCommand | undefined;
  settlement?: PlannerAttemptSettlement | undefined;
};

export type BriefQualityRunResult =
  | {
      ok: true;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
    }
  | {
      ok: false;
      result: PlanningPhaseResult;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
    };

function parkedPlanningResult(
  state: WorkflowState,
  projection: BriefRecoveryProjectionV1,
): PlanningPhaseResult {
  return { disposition: 'parked', state, projection };
}

/**
 * Readiness is binary and contract-bound: the recovery projection must be
 * ready and its full contract report must carry zero error issues. The scalar
 * score is a diagnostic and never participates in the decision.
 */
function contractReady(projection: BriefRecoveryProjectionV1): boolean {
  if (projection.status !== 'ready') return false;
  const issues = projection.matchingReport?.issues ?? [];
  return !issues.some((issue) => issue.severity === 'error');
}

function exhaustedAutomaticQualityFailure(
  recovery: BriefQualityRecoveryBinding,
  projection: BriefRecoveryProjectionV1,
): boolean {
  const latest = projection.latestAttempt;
  if (
    projection.status !== 'blocked' ||
    latest?.status !== 'settled' ||
    latest.outcome !== 'quality-failed' ||
    recovery.readState === undefined
  )
    return false;
  let state: WorkflowState;
  try {
    state = recovery.readState();
  } catch {
    return false;
  }
  const briefRecovery = state.briefRecovery;
  if (
    briefRecovery === null ||
    briefRecovery === undefined ||
    briefRecovery.status === 'storage-blocked' ||
    briefRecovery.status === 'rejected'
  )
    return false;
  const operationId = briefRecovery.automaticRepair.operationId;
  const attempt = operationId === null ? undefined : briefRecovery.attempts[operationId];
  return (
    briefRecovery.automaticRepair.consumed &&
    latest.operationId === operationId &&
    attempt?.kind === 'automatic' &&
    attempt.status === 'settled' &&
    attempt.outcome === 'quality-failed'
  );
}

function terminalQualityFailure(opts: {
  state: WorkflowState;
  projection: BriefRecoveryProjectionV1;
  run: BriefQualityRunOptions;
}): PlanningPhaseResult {
  const issue = opts.projection.matchingReport?.issues.find(
    (candidate) => candidate.severity === 'error',
  );
  return handlePlanningFailure({
    err: planningError.briefQualityGateFailed(
      issue?.code ?? 'unknown',
      String(issue?.taskId ?? 'unknown'),
    ),
    projectDir: opts.run.wctx.projectDir,
    sessionId: opts.run.wctx.sessionId,
    state: opts.state,
    wctx: opts.run.wctx,
  });
}

function preparationOptions(opts: BriefQualityRunOptions): PreparationOptions {
  const { wctx } = opts;
  return {
    tasks: opts.tasks,
    state: opts.state,
    planner: opts.planner,
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    callbacks: wctx.callbacks,
    bus: wctx.bus,
    metadata: wctx.metadata,
    ...(wctx.signal !== undefined ? { signal: wctx.signal } : {}),
    ...(wctx.sinks !== undefined ? { sinks: wctx.sinks } : {}),
    ...(opts.queuedMessages !== undefined ? { queuedMessages: opts.queuedMessages } : {}),
    ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
  } satisfies PreparationOptions;
}

async function applyControllerOperations(
  opts: BriefQualityRunOptions,
  projection: BriefRecoveryProjectionV1,
  recovery: BriefQualityControllerResult | null,
): Promise<{
  projection: BriefRecoveryProjectionV1;
  recovery: BriefQualityControllerResult | null;
}> {
  if (opts.recovery === undefined) return { projection, recovery };
  let currentProjection = projection;
  let currentRecovery = recovery;
  if (opts.action !== undefined) {
    currentRecovery = await opts.recovery.controller.dispatchBriefAction(
      opts.action,
      opts.recovery.authority,
    );
    currentProjection = currentRecovery.projection;
  }
  if (opts.settlement !== undefined) {
    currentRecovery = await opts.recovery.controller.settlePlannerAttempt(
      opts.settlement,
      opts.recovery.authority,
    );
    currentProjection = currentRecovery.projection;
  }
  return { projection: currentProjection, recovery: currentRecovery };
}

export async function runBriefQuality(
  opts: BriefQualityRunOptions,
): Promise<BriefQualityRunResult> {
  const preparation = preparationOptions(opts);
  try {
    const prepared = await prepareBriefQuality(preparation);
    if (opts.recovery === undefined) {
      if (!prepared.ok) {
        return {
          ok: false,
          result: handlePlanningFailure({
            err: prepared.error,
            projectDir: opts.wctx.projectDir,
            sessionId: opts.wctx.sessionId,
            state: prepared.state,
            wctx: opts.wctx,
          }),
          state: prepared.state,
          tasks: prepared.tasks,
          report: prepared.report,
          projection: prepared.projection,
          recovery: null,
        };
      }
      return {
        ok: true,
        state: prepared.state,
        tasks: prepared.tasks,
        report: prepared.report,
        projection: prepared.projection,
        recovery: null,
      };
    }

    const applied = await applyControllerOperations(opts, prepared.projection, prepared.recovery);
    const report = briefQualityReportFromProjection(applied.projection);
    if (contractReady(applied.projection)) {
      return {
        ok: true,
        state: prepared.state,
        tasks: prepared.tasks,
        report,
        projection: applied.projection,
        recovery: applied.recovery,
      };
    }
    if (
      applied.recovery !== null &&
      exhaustedAutomaticQualityFailure(opts.recovery, applied.projection)
    ) {
      const result = terminalQualityFailure({
        state: prepared.state,
        projection: applied.projection,
        run: opts,
      });
      return {
        ok: false,
        result,
        state: result.state,
        tasks: prepared.tasks,
        report,
        projection: applied.projection,
        recovery: applied.recovery,
      };
    }
    return {
      ok: false,
      result: parkedPlanningResult(prepared.state, applied.projection),
      state: prepared.state,
      tasks: prepared.tasks,
      report,
      projection: applied.projection,
      recovery: applied.recovery,
    };
  } catch (err) {
    if (opts.recovery !== undefined) throw err;
    return {
      ok: false,
      result: handlePlanningFailure({
        err,
        projectDir: opts.wctx.projectDir,
        sessionId: opts.wctx.sessionId,
        state: opts.state,
        wctx: opts.wctx,
      }),
      state: opts.state,
      tasks: opts.tasks,
      report: {
        version: 1,
        passed: false,
        score: 0,
        issues: [],
      },
      projection: fallbackBriefRecoveryProjection(opts.wctx.sessionId, opts.state),
      recovery: null,
    };
  }
}
