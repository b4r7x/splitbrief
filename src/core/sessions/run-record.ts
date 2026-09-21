import type { WorkflowMode } from '../schemas/enums.js';
import type { EvidenceLedger } from '../schemas/evidence.js';
import type { Summary } from '../schemas/summary.js';
import type { SessionRef } from '../types/session-ref.js';
import type { OwnedResumeState } from '../state/resume-hydration.js';
import { deriveRunStatus, type ArtifactPresence, type RunStatus } from './run-status.js';

/** The accept/reject decision the run ledger records; the loader maps it out of engine shapes. */
export type RunCheckpoint = Readonly<{ kind: 'accepted' | 'rejected' }>;

export interface RunRecord {
  ref: SessionRef;
  feature: string;
  mode: WorkflowMode | null;
  startedAt: string | null;
  hydration: OwnedResumeState;
  status: RunStatus;
  summary: Summary | null;
  ledger: EvidenceLedger | null;
  checkpoint: RunCheckpoint | null;
}

export interface RunRecordDeps {
  loadResumeState: (ref: SessionRef) => OwnedResumeState;
  liveness: (ref: SessionRef) => 'alive' | 'not-alive';
  readSummary: (ref: SessionRef) => Summary | null;
  readLedger: (ref: SessionRef) => EvidenceLedger | null;
  artifacts: (ref: SessionRef) => ArtifactPresence;
  readCheckpoint: (ref: SessionRef) => RunCheckpoint | null;
}

function unreadableState(hydration: OwnedResumeState): RunStatus {
  const message =
    hydration.kind === 'invalid' ? hydration.message : 'Session has no saved state to read.';
  // The record reports what it found; whether an unreadable run is still offered
  // as resumable is the caller's decision, not this loader's.
  return {
    kind: 'open',
    stop: { kind: 'failed', message },
    resumeAt: { kind: 'planner', call: 'research' },
  };
}

/** Everything one run is, read once: its state, whether it is live, and what it left on disk. */
export function loadRunRecord(ref: SessionRef, deps: RunRecordDeps): RunRecord {
  const hydration = deps.loadResumeState(ref);
  const state = hydration.kind === 'loaded' ? hydration.state : null;
  const summary = deps.readSummary(ref);
  return {
    ref,
    feature: state?.feature ?? summary?.feature ?? '',
    mode: state?.mode ?? summary?.mode ?? null,
    startedAt: state?.startedAt ?? null,
    hydration,
    status:
      state === null
        ? unreadableState(hydration)
        : deriveRunStatus({
            state,
            liveness: deps.liveness(ref),
            artifacts: deps.artifacts(ref),
          }),
    summary,
    ledger: deps.readLedger(ref),
    checkpoint: deps.readCheckpoint(ref),
  };
}
