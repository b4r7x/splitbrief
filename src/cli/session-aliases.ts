import { readdirSync, existsSync } from 'node:fs';
import { readLockfile, type LockfileData } from '../engine/ipc/lockfile.js';
import { sessionsRoot, sessionDir } from '../core/paths.js';
import { cliError } from './errors.js';

export type AliasedSession = {
  alias: number;
  sessionId: string;
  lockfile: LockfileData;
};

export type AliasableSession = {
  sessionId: string;
  lockfile: LockfileData;
};

export function assignSessionAliases(sessions: AliasableSession[]): AliasedSession[] {
  return [...sessions]
    .sort((a, b) => b.lockfile.startTimeMs - a.lockfile.startTimeMs)
    .map((s, i) => ({
      alias: i + 1,
      sessionId: s.sessionId,
      lockfile: s.lockfile,
    }));
}

export async function buildAliasedSessions(projectDir: string): Promise<AliasedSession[]> {
  const root = sessionsRoot(projectDir);

  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());

  const sessions: { sessionId: string; lockfile: LockfileData }[] = [];

  for (const entry of entries) {
    const sessDir = sessionDir(projectDir, entry.name);
    const data = await readLockfile(sessDir);
    if (!data) continue;
    sessions.push({ sessionId: entry.name, lockfile: data });
  }

  return assignSessionAliases(sessions);
}

const NUMERIC_PATTERN = /^\d+$/;

export function isNumericAlias(input: string): boolean {
  return NUMERIC_PATTERN.test(input);
}

export async function resolveNumericAlias(
  input: string,
  projectDir: string,
): Promise<string> {
  const num = parseInt(input, 10);

  if (num < 1) {
    throw cliError(`invalid session alias "${input}"; aliases start at 1.`, 1);
  }

  const sessions = await buildAliasedSessions(projectDir);

  if (sessions.length === 0) {
    throw cliError('no sessions found; start one with `diptych start`.', 1);
  }

  const match = sessions.find((s) => s.alias === num);

  if (!match) {
    throw cliError(
      `session alias ${num} is out of range; there are ${sessions.length} session(s). Use \`diptych ps\` to see them.`,
      1,
    );
  }

  return match.sessionId;
}
