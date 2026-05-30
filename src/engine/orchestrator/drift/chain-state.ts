import { join } from 'node:path';
import type { ActiveDriftChain, DriftChainState } from '../../../core/schemas/drift-chain.js';
import { DriftChainStateSchema } from '../../../core/schemas/drift-chain.js';
import { DRIFT_CHAINS_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';

export function initialDriftChainState(sessionId: string): DriftChainState {
  return {
    version: 1,
    sessionId,
    activeChain: emptyActiveChain(),
    emittedChains: [],
  };
}

export function driftChainsPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), DRIFT_CHAINS_FILE);
}

export function readDriftChainState(projectDir: string, sessionId: string): DriftChainState | null {
  const raw = readJsonSafe(driftChainsPath(projectDir, sessionId));
  if (raw === null) return null;
  const result = DriftChainStateSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function writeDriftChainState(
  projectDir: string,
  sessionId: string,
  state: DriftChainState,
): void {
  writeSecureFile(driftChainsPath(projectDir, sessionId), `${JSON.stringify(state, null, 2)}\n`);
}

export function emptyActiveChain(): ActiveDriftChain {
  return { entries: [], uniqueFiles: [], score: 0 };
}

export function resetDriftChainState(projectDir: string, sessionId: string): void {
  const empty = initialDriftChainState(sessionId);
  writeDriftChainState(projectDir, sessionId, empty);
}
