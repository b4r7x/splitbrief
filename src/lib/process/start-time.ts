import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const SYSTEM_PS_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  aix: ['/usr/bin/ps'],
  darwin: ['/bin/ps', '/usr/bin/ps'],
  freebsd: ['/bin/ps', '/usr/bin/ps'],
  linux: ['/bin/ps', '/usr/bin/ps'],
  netbsd: ['/bin/ps', '/usr/bin/ps'],
  openbsd: ['/bin/ps', '/usr/bin/ps'],
  sunos: ['/usr/bin/ps'],
};

function systemPsPath(): string | null {
  const candidates = SYSTEM_PS_PATHS[process.platform];
  if (candidates === undefined) return null;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function currentProcessStartTimeMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * The self path returns the node baseline while the `ps` path returns the
 * kernel's whole-second start time, so the two are not comparable below a
 * second: callers must judge identity with a tolerance, never with equality.
 */
export function readProcessStartTimeMs(pid: number): number | null {
  if (pid === process.pid) return currentProcessStartTimeMs();

  const psPath = systemPsPath();
  if (psPath === null) return null;

  try {
    const stdout = execFileSync(psPath, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}
