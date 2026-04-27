import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveDriftChain, DriftChainState } from '../../core/schemas/drift-chain.js';
import { DriftChainStateSchema } from '../../core/schemas/drift-chain.js';
import { DRIFT_CHAINS_FILE, sessionDir } from '../../core/paths.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../lib/fs.js';

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
  const target = driftChainsPath(projectDir, sessionId);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    const result = DriftChainStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function writeDriftChainState(
  projectDir: string,
  sessionId: string,
  state: DriftChainState,
): void {
  ensureSecureDir(sessionDir(projectDir, sessionId));
  writeFileSync(
    driftChainsPath(projectDir, sessionId),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: SECURE_FILE_MODE },
  );
}

export function emptyActiveChain(): ActiveDriftChain {
  return { entries: [], uniqueFiles: [], score: 0 };
}

export function resetDriftChainState(projectDir: string, sessionId: string): void {
  const empty = initialDriftChainState(sessionId);
  writeDriftChainState(projectDir, sessionId, empty);
}
