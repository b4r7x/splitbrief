import { join } from 'node:path';
import type { ActiveDriftChain, DriftChainState } from '../../../core/schemas/drift-chain.js';
import { DriftChainStateSchema } from '../../../core/schemas/drift-chain.js';
import { DRIFT_CHAINS_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export function initialDriftChainState(sessionId: string): DriftChainState {
  return {
    version: 1,
    sessionId,
    activeChain: emptyActiveChain(),
    emittedChains: [],
  };
}

export function driftChainsPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), DRIFT_CHAINS_FILE);
}

export function readDriftChainState(ref: SessionRef): DriftChainState | null {
  const raw = readJsonSafe(driftChainsPath(ref));
  if (raw === null) return null;
  const result = DriftChainStateSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function writeDriftChainState(ref: SessionRef, state: DriftChainState): void {
  writeSecureFile(driftChainsPath(ref), `${JSON.stringify(state, null, 2)}\n`);
}

export function emptyActiveChain(): ActiveDriftChain {
  return { entries: [], uniqueFiles: [], score: 0 };
}

export function resetDriftChainState(ref: SessionRef): void {
  const empty = initialDriftChainState(ref.sessionId);
  writeDriftChainState(ref, empty);
}
