import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { confinedReadLockfile, type LockfileData } from '../../core/sessions/lockfile.js';
import {
  sessionsRoot,
  sessionDir,
  STATE_FILE,
  SUMMARY_FILE,
  isValidSessionId,
} from '../../core/paths.js';
import { cliError } from '../errors.js';

export type AliasedSession = {
  alias: number;
  sessionId: string;
  sortKeyMs: number;
  lockfile: LockfileData | null;
};

export type AliasableSession = {
  sessionId: string;
  sortKeyMs: number;
  lockfile: LockfileData | null;
};

function listSessionDirs(projectDir: string): string[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function listValidSessionDirs(projectDir: string): string[] {
  return listSessionDirs(projectDir).filter(isValidSessionId);
}

function mtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function sessionSortKeyMs(sessDir: string, lockfile: LockfileData | null): number {
  if (lockfile) return lockfile.startTimeMs;
  return Math.max(mtimeMs(join(sessDir, STATE_FILE)), mtimeMs(join(sessDir, SUMMARY_FILE)));
}

export function assignSessionAliases(sessions: AliasableSession[]): AliasedSession[] {
  return [...sessions]
    .sort((a, b) => b.sortKeyMs - a.sortKeyMs)
    .map((s, i) => ({
      alias: i + 1,
      sessionId: s.sessionId,
      sortKeyMs: s.sortKeyMs,
      lockfile: s.lockfile,
    }));
}

export async function buildAliasedSessions(projectDir: string): Promise<AliasedSession[]> {
  const sessions: AliasableSession[] = [];

  for (const name of listValidSessionDirs(projectDir)) {
    const sessDir = sessionDir(projectDir, name);
    const lockfile = confinedReadLockfile(sessDir, name);
    const sortKeyMs = sessionSortKeyMs(sessDir, lockfile);
    if (!lockfile && sortKeyMs === 0) continue;
    sessions.push({ sessionId: name, sortKeyMs, lockfile });
  }

  return assignSessionAliases(sessions);
}

const NUMERIC_PATTERN = /^\d+$/;

export function isNumericAlias(input: string): boolean {
  return NUMERIC_PATTERN.test(input);
}

export async function resolveSessionAlias(
  sessionId: string | undefined,
  projectDir: string,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  if (isNumericAlias(sessionId)) return resolveNumericAlias(sessionId, projectDir);
  return sessionId;
}

export async function resolveNumericAlias(input: string, projectDir: string): Promise<string> {
  const num = parseInt(input, 10);

  if (num < 1) {
    throw cliError(`invalid session alias "${input}"; aliases start at 1.`, 1);
  }

  const sessions = await buildAliasedSessions(projectDir);

  if (sessions.length === 0) {
    throw cliError('no sessions found; start one with `splitbrief start`.', 1);
  }

  const match = sessions.find((s) => s.alias === num);

  if (!match) {
    throw cliError(
      `session alias ${num} is out of range; there are ${sessions.length} session(s). Use \`splitbrief ps\` to see them.`,
      1,
    );
  }

  return match.sessionId;
}
