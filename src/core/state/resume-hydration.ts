import type { WorkflowState } from '../schemas/workflow.js';
import type { SessionRef } from '../types/session-ref.js';
import { loadState } from './persistence.js';
import { classifyStateVersion, readRawState, statePath } from './state-file.js';
import type { ResumeLoadResult } from './types.js';

export type OwnedResumeState = ResumeLoadResult;

type UnsavedFailure = Readonly<{
  stateRevision: number | undefined;
  failure: NonNullable<WorkflowState['lastFailure']>;
}>;

/**
 * Why a run failed, when this process could not save it, kept against the saved state it failed
 * on. The run reads failed in this process until a later save lands; another process reads only
 * the disk, where the run stopped at its last saved step.
 */
const unsavedFailures = new Map<string, UnsavedFailure>();

export function keepUnsavedFailure(
  ref: SessionRef,
  stateRevision: number | undefined,
  failure: NonNullable<WorkflowState['lastFailure']>,
): void {
  unsavedFailures.set(statePath(ref), { stateRevision, failure });
}

function withUnsavedFailure(ref: SessionRef, state: WorkflowState): WorkflowState {
  const kept = unsavedFailures.get(statePath(ref));
  if (kept === undefined || kept.stateRevision !== state.stateRevision) return state;
  return { ...state, lastFailure: kept.failure };
}

/**
 * `loadState` collapses every unreadable file into null. This re-reads the raw
 * bytes only on that path, so a loaded state costs one read and a rejected one
 * can still say whether it was malformed or written by a newer version.
 */
export function loadOwnerWorkflowState(ref: SessionRef): OwnedResumeState {
  const state = loadState(ref);
  if (state !== null) return { kind: 'loaded', state: withUnsavedFailure(ref, state) };

  const raw = readRawState(ref);
  if (raw.kind === 'missing') return { kind: 'missing' };
  if (raw.kind === 'malformed') {
    return { kind: 'invalid', code: 'malformed', message: raw.message };
  }
  const classification = classifyStateVersion(raw.raw.value);
  if (classification.kind === 'malformed' || classification.kind === 'future-version') {
    return { kind: 'invalid', code: classification.kind, message: classification.message };
  }
  return { kind: 'invalid', code: 'malformed', message: 'State file could not be loaded.' };
}
