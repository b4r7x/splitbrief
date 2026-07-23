import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DIPTYCH_DIR, ACTIVE_FILE, STATE_FILE, SESSIONS_DIR, TREES_DIR } from '../../core/paths.js';
import { readJsonSafeAsync } from '../../lib/fs.js';
import { getCurrentBranch } from '../../lib/git/refs.js';
import { isRecord } from '../../utils/type-guards.js';
import { PhaseSchema, type Phase } from '../../core/schemas/enums.js';
import { isTerminalPhase } from '../../core/phases.js';
import { checkServerStatus, readLockfile } from '../ipc/lockfile.js';
import type { WorktreeStatus } from './errors.js';
import { assertTreesDirReadable } from './path.js';

export type WorktreeInfo = {
  name: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  sessionId: string | null;
  phase: Phase | null;
  lastUpdated: string | null;
};

async function readSessionState(
  worktreeDir: string,
  sessionId: string,
): Promise<{ phase: Phase | null; lastUpdated: string | null }> {
  const stateFile = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, STATE_FILE);
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
  return { phase: null, lastUpdated: null };
}

type WorktreeSession = {
  sessionId: string;
  phase: Phase | null;
  lastUpdated: string | null;
};

async function listWorktreeSessionIds(worktreeDir: string): Promise<string[]> {
  const sessionsDir = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function isSessionLive(worktreeDir: string, sessionId: string): Promise<boolean> {
  const { phase } = await readSessionState(worktreeDir, sessionId);
  if (phase === null || isTerminalPhase(phase)) return false;
  const sessDir = join(worktreeDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  const lockfile = await readLockfile(sessDir);
  if (lockfile === null) return true;
  const status = await checkServerStatus(sessDir);
  return status.alive;
}

export async function findLiveWorktreeSession(
  worktreeDir: string,
): Promise<WorktreeSession | null> {
  for (const sessionId of await listWorktreeSessionIds(worktreeDir)) {
    if (await isSessionLive(worktreeDir, sessionId)) {
      const { phase, lastUpdated } = await readSessionState(worktreeDir, sessionId);
      return { sessionId, phase, lastUpdated };
    }
  }
  return null;
}

export async function listWorktrees(projectDir: string): Promise<WorktreeInfo[]> {
  const treesDir = join(projectDir, TREES_DIR);
  if (!existsSync(treesDir)) return [];
  assertTreesDirReadable(projectDir);

  const entries = await readdir(treesDir, { withFileTypes: true });
  const results: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wtDir = join(treesDir, entry.name);
    const gitMarker = join(wtDir, '.git');

    if (!existsSync(gitMarker)) continue;
    if (!(await stat(gitMarker)).isFile()) continue;

    let branch = '';
    try {
      branch = await getCurrentBranch(wtDir);
    } catch {
      continue;
    }

    let sessionId: string | null = null;
    let status: WorktreeStatus = 'none';
    let phase: Phase | null = null;
    let lastUpdated: string | null = null;

    const live = await findLiveWorktreeSession(wtDir);
    if (live) {
      sessionId = live.sessionId;
      phase = live.phase;
      lastUpdated = live.lastUpdated;
      status = 'active';
    } else {
      const activeFilePath = join(wtDir, DIPTYCH_DIR, ACTIVE_FILE);
      if (existsSync(activeFilePath)) {
        const content = (await readFile(activeFilePath, 'utf-8')).trim();
        sessionId = content || null;
        if (sessionId) {
          const state = await readSessionState(wtDir, sessionId);
          phase = state.phase;
          lastUpdated = state.lastUpdated;
          status = 'idle';
        }
      }
    }

    results.push({
      name: entry.name,
      path: wtDir,
      branch,
      status,
      sessionId,
      phase,
      lastUpdated,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
