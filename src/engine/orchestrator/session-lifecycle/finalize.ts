import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { WORKFLOW_STATE_VERSION, type WorkflowState } from '../../../core/schemas/workflow.js';
import {
  clearActiveReceipt,
  readActiveRecord,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import { readSession, rowFor, saveSummary } from '../../../core/sessions/io.js';
import { deriveRunStatus, type RunStatus } from '../../../core/sessions/run-status.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { runSeatIdentity } from '../../../core/providers/seat-identity.js';
import { buildSummary } from '../summary/build.js';

export type SaveFinalSessionOpts = {
  projectDir: string;
  sessionId: string;
  active?: ActiveSessionReceipt | undefined;
  feature: string;
  startTime: number;
  summary: Summary;
  /** The state this run last tracked; the session's status is derived from it. */
  state: WorkflowState | null | undefined;
};

// The run has stopped by the time this is called, so liveness is settled; a run
// with no tracked state never reached a phase, so it is open and interrupted.
const NO_STATE: RunStatus = {
  kind: 'open',
  stop: { kind: 'stopped', on: { kind: 'interrupted' } },
  resumeAt: { kind: 'planner', call: 'plan' },
};

function finalRunStatus(opts: Pick<SaveFinalSessionOpts, 'projectDir' | 'sessionId' | 'state'>) {
  if (!opts.state) return NO_STATE;
  return deriveRunStatus({
    state: opts.state,
    liveness: 'not-alive',
  });
}

function sessionFor(opts: SaveFinalSessionOpts, status: RunStatus): Session {
  const base = {
    id: opts.sessionId,
    feature: opts.summary.feature,
    startedAt: opts.startTime,
    completedAt: Date.now(),
    stateVersion: WORKFLOW_STATE_VERSION,
    ...(opts.state?.phase !== undefined && { phase: opts.state.phase }),
  };
  return rowFor(base, status, opts.summary);
}

/**
 * A run ended outside `runWorkflow` — the operator answered a halt with End run,
 * so the loop never re-entered the engine. The session still gets the record
 * every other ending gets, through the same finalize.
 */
export function finalizeEndedRun(
  input: Readonly<{
    ref: SessionRef;
    active?: ActiveSessionReceipt | undefined;
    config: Config;
    state: WorkflowState;
    modelCache?: ModelCacheAccessor | undefined;
  }>,
): Summary {
  const { ref, state, config } = input;
  const ident = runSeatIdentity(config);
  const summary = buildSummary({
    feature: state.feature,
    startTime: Date.parse(state.startedAt) || Date.now(),
    plannerTool: ident.plannerTool,
    ...(ident.plannerModel !== undefined && { plannerModel: ident.plannerModel }),
    ...(ident.plannerKind !== undefined && { plannerKind: ident.plannerKind }),
    implementerTool: ident.implementerTool,
    ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
    ...(ident.implementerKind !== undefined && { implementerKind: ident.implementerKind }),
    ...(ident.reviewerTool !== undefined && { reviewerTool: ident.reviewerTool }),
    ...(ident.reviewerModel !== undefined && { reviewerModel: ident.reviewerModel }),
    ...(ident.reviewerKind !== undefined && { reviewerKind: ident.reviewerKind }),
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    ...(input.modelCache !== undefined && { pricingCache: input.modelCache }),
    state,
  });
  saveFinalSession({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    active: input.active,
    feature: state.feature,
    startTime: Date.parse(state.startedAt) || Date.now(),
    summary,
    state,
  });
  return summary;
}

/** A run settled at rest — no live loop holds its receipt — clears the active session only while it is this run's. */
export function finalizeRunAtRest(
  input: Readonly<{ ref: SessionRef; config: Config; state: WorkflowState }>,
): Summary {
  const active = readActiveRecord(input.ref.projectDir);
  const receipt =
    active?.kind === 'v1' && active.receipt.sessionId === input.ref.sessionId
      ? active.receipt
      : undefined;
  return finalizeEndedRun({ ...input, active: receipt });
}

/**
 * A resumed run is running again, so the stop its last pass wrote is no longer true. The record
 * drops it as the pass starts rather than when it ends: until then `summary.json` — and a listing
 * that falls back to it when the state cannot be read — would go on reporting the old stop.
 */
export function reopenSessionRecord(ref: SessionRef): void {
  const session = readSession(ref);
  if (session?.status !== 'open' || session.stop === undefined) return;
  const { stop: _stop, ...running } = session;
  saveSummary(ref, running);
}

export function saveFinalSession(opts: SaveFinalSessionOpts): void {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const status = finalRunStatus(opts);
  saveSummary(ref, sessionFor(opts, status));
  if (status.kind === 'closed' && opts.active !== undefined) clearActiveReceipt(ref, opts.active);
}
