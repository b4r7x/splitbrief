import { readdirSync, existsSync } from 'node:fs';
import { sessionsRoot, sessionDir } from '../../core/paths.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';

export type SingleRunningSessionResult =
  | { kind: 'single'; id: string }
  | { kind: 'none' }
  | { kind: 'multiple'; ids: string[] };

export interface ScanRunningSessionsDeps {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
}

export async function findSingleRunningSession(
  projectDir: string,
  deps: ScanRunningSessionsDeps,
): Promise<SingleRunningSessionResult> {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return { kind: 'none' };

  const entries = readdirSync(root, { withFileTypes: true });
  const running: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = await deps.checkServerStatus(sessionDir(projectDir, entry.name));
    if (status.alive) running.push(entry.name);
  }

  const [single] = running;
  if (running.length === 1 && single) return { kind: 'single', id: single };
  if (running.length === 0) return { kind: 'none' };
  return { kind: 'multiple', ids: running };
}
