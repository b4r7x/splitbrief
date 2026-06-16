import { execFileSync } from 'node:child_process';

export function currentProcessStartTimeMs(): number {
  return Date.now() - process.uptime() * 1000;
}

export function readProcessStartTimeMs(pid: number): number | null {
  if (pid === process.pid) return currentProcessStartTimeMs();

  try {
    const stdout = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}
