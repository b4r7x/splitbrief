import { readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVER_LOG_FILE } from '../../core/paths.js';
import type { LockfileData, ServerStatus } from './lockfile.js';

export type CrashDiagnostic = {
  sessionId: string;
  status: 'crashed' | 'exited';
  pid: number | null;
  startedAt: number | null;
  lastAliveAt: number | null;
  exitedAt: number | null;
  signal: string | null;
  exitCode: number | null;
  cause: string | null;
  logTail: string | null;
};

async function readLastLines(filePath: string, n: number): Promise<string | null> {
  try {
    const CHUNK = 32 * 1024;
    const info = await stat(filePath);
    let raw: string;
    if (info.size < 100 * 1024) {
      raw = await readFile(filePath, 'utf-8');
    } else {
      const fd = await open(filePath, 'r');
      try {
        const offset = Math.max(0, info.size - CHUNK);
        const buf = Buffer.alloc(Math.min(CHUNK, info.size));
        await fd.read(buf, 0, buf.length, offset);
        raw = buf.toString('utf-8');
        // drop the (likely) incomplete first line
        const firstNewline = raw.indexOf('\n');
        if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
      } finally {
        await fd.close();
      }
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n).join('\n') || null;
  } catch {
    return null;
  }
}

export async function buildCrashDiagnostic(
  sessionDir: string,
  status: ServerStatus,
): Promise<CrashDiagnostic> {
  const data: LockfileData | null = status.alive ? null : status.data;

  const sessionId = data?.sessionId ?? 'unknown';
  const pid = data?.pid ?? null;
  const startedAt = data?.startTimeMs ?? null;
  const lastAliveAt = data?.lastAliveMs ?? null;
  const exitedAt = data?.exitedAt ?? null;
  const signal = data?.signal ?? null;
  const exitCode = data?.exitCode ?? null;
  const cause = data?.cause ?? null;

  const diagStatus: 'crashed' | 'exited' =
    !status.alive && status.crashed ? 'crashed' : 'exited';

  const logPath = join(sessionDir, SERVER_LOG_FILE);
  const logTail = await readLastLines(logPath, 20);

  return {
    sessionId,
    status: diagStatus,
    pid,
    startedAt,
    lastAliveAt,
    exitedAt,
    signal,
    exitCode,
    cause,
    logTail,
  };
}
