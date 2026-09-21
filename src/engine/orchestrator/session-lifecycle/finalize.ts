import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { WORKFLOW_STATE_VERSION, type WorkflowState } from '../../../core/schemas/workflow.js';
import {
  clearActiveReceipt,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import {
  deriveRunStatus,
  NO_ARTIFACTS,
  type RunStatus,
} from '../../../core/sessions/run-status.js';
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
  stop: { kind: 'interrupted' },
  resumeAt: { kind: 'planner', call: 'research' },
};

function finalRunStatus(opts: Pick<SaveFinalSessionOpts, 'projectDir' | 'sessionId' | 'state'>) {
  if (!opts.state) return NO_STATE;
  return deriveRunStatus({
    state: opts.state,
    liveness: 'not-alive',
    artifacts: artifactPresence({ projectDir: opts.projectDir, sessionId: opts.sessionId }),
  });
}

/** Artifacts only shape `resumeAt`, so the preserve decision reads the state alone. */
export function shouldPreserveActiveState(state: WorkflowState | null | undefined): boolean {
  if (!state) return false;
  const status = deriveRunStatus({ state, liveness: 'not-alive', artifacts: NO_ARTIFACTS });
  return status.kind !== 'closed';
}

function sessionFor(opts: SaveFinalSessionOpts, status: RunStatus): Session {
  const base = {
    id: opts.sessionId,
    feature: opts.summary.feature,
    startedAt: opts.startTime,
    completedAt: Date.now(),
    stateVersion: WORKFLOW_STATE_VERSION,
    ...(opts.state?.phase !== undefined && { phase: opts.state.phase }),
    ...(opts.state?.mode !== undefined && { mode: opts.state.mode }),
  };
  if (status.kind === 'closed') {
    return status.as === 'complete'
      ? { ...base, status: 'complete', summary: opts.summary }
      : { ...base, status: 'ended', summary: opts.summary };
  }
  if (status.kind === 'running') return { ...base, status: 'open', summary: opts.summary };
  return { ...base, status: 'open', summary: opts.summary, stop: status.stop.kind };
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
    implementerTool: ident.implementerTool,
    ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
    ...(ident.reviewerTool !== undefined && { reviewerTool: ident.reviewerTool }),
    ...(ident.reviewerModel !== undefined && { reviewerModel: ident.reviewerModel }),
    ...(state.mode !== undefined && { mode: state.mode }),
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

export function saveFinalSession(opts: SaveFinalSessionOpts): void {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const status = finalRunStatus(opts);
  saveSummary(ref, sessionFor(opts, status));
  if (status.kind === 'closed' && opts.active !== undefined) clearActiveReceipt(ref, opts.active);
}
