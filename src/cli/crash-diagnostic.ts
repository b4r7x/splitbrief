import type { ServerStatus } from '../engine/ipc/lockfile.js';
import { buildCrashDiagnostic, type CrashDiagnostic } from '../engine/ipc/crash-diagnostic.js';

function formatTimestamp(ms: number | null): string {
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function formatCrashDiagnostic(diag: CrashDiagnostic): string {
  const label = diag.status === 'crashed' ? 'CRASHED' : 'EXITED CLEANLY';
  const header = `Session ${diag.sessionId} — ${label}`;
  const width = Math.max(44, header.length + 4);
  const innerWidth = width - 4;
  const padded = header.padEnd(innerWidth);
  const top = `╔${'═'.repeat(width - 2)}╗`;
  const mid = `║  ${padded}  ║`;
  const bot = `╚${'═'.repeat(width - 2)}╝`;

  const lines: string[] = [top, mid, bot, ''];

  lines.push(`  Session ID   : ${diag.sessionId}`);
  if (diag.pid !== null) lines.push(`  PID          : ${diag.pid}`);
  else lines.push('  PID          : unknown');
  if (diag.startedAt !== null) lines.push(`  Started      : ${formatTimestamp(diag.startedAt)}`);
  if (diag.lastAliveAt !== null) lines.push(`  Last alive   : ${formatTimestamp(diag.lastAliveAt)}`);
  if (diag.exitedAt !== null) lines.push(`  Exited at    : ${formatTimestamp(diag.exitedAt)}`);
  if (diag.signal !== null) lines.push(`  Exit signal  : ${diag.signal}`);
  if (diag.exitCode !== null) lines.push(`  Exit code    : ${diag.exitCode}`);
  if (diag.cause !== null) lines.push(`  Cause        : ${diag.cause}`);

  if (diag.status === 'crashed' && diag.logTail !== null) {
    const sep = `  ${'─'.repeat(width - 4)}`;
    lines.push('');
    lines.push('  Last lines of server.log:');
    lines.push(sep);
    for (const l of diag.logTail.split('\n')) {
      lines.push(`  ${l}`);
    }
    lines.push(sep);
  }

  lines.push('');
  lines.push('  Options:');
  lines.push('    [1] Exit and run `diptych start` for a new workflow');
  lines.push('    [2] Exit and inspect logs manually');

  return lines.join('\n');
}

export async function waitForCrashDiagnosticOption(): Promise<string> {
  if (!process.stdin.isTTY) {
    return '2';
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (chunk: Buffer) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(chunk.toString('utf-8'));
    });
  });
}

export async function showCrashDiagnostic(
  sessionDir: string,
  status: ServerStatus,
  waitForKey: () => Promise<string> = waitForCrashDiagnosticOption,
): Promise<void> {
  const diag = await buildCrashDiagnostic(sessionDir, status);
  const formatted = formatCrashDiagnostic(diag);
  process.stdout.write(formatted + '\n');

  const key = await waitForKey();
  if (key === '1') {
    process.stdout.write(
      'Exiting. Run `diptych start` to begin a new workflow.\n',
    );
    process.exit(0);
  }
  process.exit(0);
}
