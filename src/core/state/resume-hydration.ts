import type { SessionRef } from '../types/session-ref.js';
import { loadState } from './persistence.js';
import { classifyStateVersion, readRawState } from './state-file.js';
import type { ResumeLoadResult } from './types.js';

export type OwnedResumeState = ResumeLoadResult;

/**
 * `loadState` collapses every unreadable file into null. This re-reads the raw
 * bytes only on that path, so a loaded state costs one read and a rejected one
 * can still say whether it was malformed or written by a newer version.
 */
export function loadOwnerWorkflowState(ref: SessionRef): OwnedResumeState {
  const state = loadState(ref);
  if (state !== null) return { kind: 'loaded', state };

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
