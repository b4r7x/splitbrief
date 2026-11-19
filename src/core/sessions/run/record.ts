import type { EvidenceLedger } from '../../schemas/evidence.js';
import type { Summary } from '../../schemas/summary.js';
import type { SessionRef } from '../../types/session-ref.js';
import type { OwnedResumeState } from '../../state/resume-hydration.js';
import { deriveRunStatus, type RunStatus } from './status.js';

/**
 * The accept/reject decision the run ledger records; the loader maps it out of engine shapes. A
 * reject carries what it put back (`removed` is the part of `restored` the run had created),
 * absent on a ledger from before it was kept.
 */
export type RunCheckpoint =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{
      kind: 'rejected';
      putBack?: Readonly<{ restored: readonly string[]; removed: readonly string[] }> | undefined;
    }>;

export type RunOwner = Readonly<{ kind: 'live' | 'stale'; pid: number }>;

export interface RunRecord {
  ref: SessionRef;
  feature: string;
  startedAt: string | null;
  hydration: OwnedResumeState;
  status: RunStatus;
  owner?: RunOwner | undefined;
  summary: Summary | null;
  ledger: EvidenceLedger | null;
  checkpoint: RunCheckpoint | null;
}

export interface RunRecordDeps {
  loadResumeState: (ref: SessionRef) => OwnedResumeState;
  readOwner: (ref: SessionRef) => RunOwner | undefined;
  readSummary: (ref: SessionRef) => Summary | null;
  readLedger: (ref: SessionRef) => EvidenceLedger | null;
  readCheckpoint: (ref: SessionRef) => RunCheckpoint | null;
}

export function isRunHeld(record: RunRecord): boolean {
  return record.owner !== undefined || record.status.kind === 'running';
}

export function isRunHeldElsewhere(record: RunRecord): boolean {
  return isRunHeld(record) && record.owner?.pid !== process.pid;
}

function unreadableState(): RunStatus {
  // The record reports what it found; whether an unreadable run is still offered
  // as resumable is the caller's decision, not this loader's.
  return {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'failed' } },
    resumeAt: { kind: 'planner', call: 'plan' },
  };
}

/**
 * Everything one run is, read once: its state, whether it is live, and what it left on disk.
 * `reviewNone` is REVIEW None in the config the next pass runs on.
 */
export function loadRunRecord(
  ref: SessionRef,
  deps: RunRecordDeps,
  reviewNone: boolean,
): RunRecord {
  const hydration = deps.loadResumeState(ref);
  const state = hydration.kind === 'loaded' ? hydration.state : null;
  const summary = deps.readSummary(ref);
  const owner = deps.readOwner(ref);
  return {
    ref,
    feature: state?.feature ?? summary?.feature ?? '',
    startedAt: state?.startedAt ?? null,
    hydration,
    ...(owner !== undefined && { owner }),
    status:
      state === null
        ? owner === undefined
          ? unreadableState()
          : { kind: 'running' }
        : deriveRunStatus({
            state,
            liveness: owner === undefined ? 'not-alive' : 'alive',
            reviewNone,
          }),
    summary,
    ledger: deps.readLedger(ref),
    checkpoint: deps.readCheckpoint(ref),
  };
}
