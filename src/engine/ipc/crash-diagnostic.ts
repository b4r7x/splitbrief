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

function formatTimestamp(ms: number | null): string {
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function formatCrashDiagnostic(diag: CrashDiagnostic): string {
  const label = diag.status === 'crashed' ? 'CRASHED' : 'EXITED CLEANLY';
  const header = `Session ${diag.sessionId} — ${label}`;
  const width = Math.max(44, header.length + 4);
  const innerWidth = width - 4; // 2 for "║  " and 2 for "  ║"
  const padded = header.padEnd(innerWidth);
  const top = `╔${'═'.repeat(width - 2)}╗`;
  const mid = `║  ${padded}  ║`;
  const bot = `╚${'═'.repeat(width - 2)}╝`;

  const lines: string[] = [top, mid, bot, ''];

  lines.push(`  Session ID   : ${diag.sessionId}`);
  if (diag.pid !== null) lines.push(`  PID          : ${diag.pid}`);
  else lines.push(`  PID          : unknown`);
  if (diag.startedAt !== null) lines.push(`  Started      : ${formatTimestamp(diag.startedAt)}`);
  if (diag.lastAliveAt !== null) lines.push(`  Last alive   : ${formatTimestamp(diag.lastAliveAt)}`);
  if (diag.exitedAt !== null) lines.push(`  Exited at    : ${formatTimestamp(diag.exitedAt)}`);
  if (diag.signal !== null) lines.push(`  Exit signal  : ${diag.signal}`);
  if (diag.exitCode !== null) lines.push(`  Exit code    : ${diag.exitCode}`);
  if (diag.cause !== null) lines.push(`  Cause        : ${diag.cause}`);

  if (diag.status === 'crashed' && diag.logTail !== null) {
    const sep = `  ${'─'.repeat(width - 4)}`;
    lines.push('');
    lines.push(`  Last lines of server.log:`);
    lines.push(sep);
    for (const l of diag.logTail.split('\n')) {
      lines.push(`  ${l}`);
    }
    lines.push(sep);
  }

  lines.push('');
  lines.push('  Options:');
  lines.push('    [1] Start a new workflow for the same feature');
  lines.push('    [2] Exit and inspect logs manually');

  return lines.join('\n');
}

async function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (chunk: Buffer) => {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(chunk.toString('utf-8'));
    });
  });
}

export async function showCrashDiagnostic(
  sessionDir: string,
  status: ServerStatus,
  _waitForKey: () => Promise<string> = waitForKey,
): Promise<void> {
  const diag = await buildCrashDiagnostic(sessionDir, status);
  const formatted = formatCrashDiagnostic(diag);
  process.stdout.write(formatted + '\n');

  const key = await _waitForKey();
  if (key === '1') {
    process.stdout.write('Starting new workflow...\n');
    return;
  }
  process.exit(0);
}
