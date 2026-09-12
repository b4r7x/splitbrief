import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SPLITBRIEF_DIR, STATE_FILE, SESSIONS_DIR } from '../../../core/paths.js';
import { readJsonSafeAsync } from '../../../lib/fs.js';
import { isRecord } from '../../../utils/type-guards.js';
import { PhaseSchema, type Phase } from '../../../core/schemas/enums.js';
import { isTerminalPhase } from '../../../core/phases.js';
import { checkSessionLiveness, readLockfile } from '../../../core/sessions/lockfile.js';

async function readSessionState(
  worktreeDir: string,
  sessionId: string,
): Promise<{ phase: Phase | null; lastUpdated: string | null }> {
  const stateFile = join(worktreeDir, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, STATE_FILE);
  if (!existsSync(stateFile)) return { phase: null, lastUpdated: null };
  let lastUpdated: string | null = null;
  try {
    lastUpdated = (await stat(stateFile)).mtime.toISOString();
  } catch {
    lastUpdated = null;
  }
  const raw = await readJsonSafeAsync(stateFile);
  if (isRecord(raw)) {
    const phase = PhaseSchema.safeParse(raw.phase);
    if (phase.success) return { phase: phase.data, lastUpdated };
  }
  return { phase: null, lastUpdated };
}

type WorktreeSession = {
  sessionId: string;
  phase: Phase | null;
  lastUpdated: string | null;
};

async function listWorktreeSessionIds(worktreeDir: string): Promise<string[]> {
  const sessionsDir = join(worktreeDir, SPLITBRIEF_DIR, SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function isSessionLive(worktreeDir: string, sessionId: string, phase: Phase | null): boolean {
  if (phase === null || isTerminalPhase(phase)) return false;
  const sessDir = join(worktreeDir, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
  const lockfile = readLockfile(sessDir);
  if (lockfile === null) return true;
  const status = checkSessionLiveness(sessDir);
  return status.alive;
}

export async function findLiveWorktreeSession(
  worktreeDir: string,
): Promise<WorktreeSession | null> {
  for (const sessionId of await listWorktreeSessionIds(worktreeDir)) {
    const { phase, lastUpdated } = await readSessionState(worktreeDir, sessionId);
    if (isSessionLive(worktreeDir, sessionId, phase)) {
      return { sessionId, phase, lastUpdated };
    }
  }
  return null;
}
