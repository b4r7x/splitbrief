import { resolveBareCommandOnPath } from '../../../lib/process/command-path.js';
import { absolutePathEntries } from '../../../lib/process/spawn/child-env.js';
import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

/** What Claude Code's sandbox needs on Linux. macOS ships `sandbox-exec`, so it needs nothing. */
const LINUX_SANDBOX_PROGRAMS = ['bwrap', 'socat'] as const;

const SANDBOX_FIX =
  'Install bubblewrap and socat (for example `sudo apt-get install bubblewrap socat`), then run `splitbrief doctor` again. On Ubuntu 24.04 and later, bwrap also needs an AppArmor profile that allows user namespaces.';

/**
 * Whether `program` is on the PATH the seat finds it on. The seat's PATH keeps only absolute
 * entries, so a relative or empty entry, which resolves against the project, does not count.
 */
export function isOnSeatPath(
  program: string,
  projectDir: string,
  path: string | undefined = process.env['PATH'],
): boolean {
  const seatPath = absolutePathEntries(path);
  return seatPath !== '' && resolveBareCommandOnPath(program, projectDir, seatPath) !== null;
}

/**
 * The claude-code implementer runs its shell commands in Claude Code's sandbox with
 * `failIfUnavailable: true`, so on Linux a missing `bwrap` or `socat` stops the seat at
 * startup. Readiness names the missing program before the run pays for planning. Like
 * availability, it blocks only when the default implementer profile is that seat.
 */
export function buildClaudeSandboxChecks(
  config: Config,
  host: Readonly<{ platform: NodeJS.Platform; isOnPath: (program: string) => boolean }>,
): ReadinessCheck[] {
  if (host.platform !== 'linux') return [];
  let profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'];
  try {
    profiles = resolveImplementerProfiles(config).profiles;
  } catch {
    // The runner checks already report a broken profile setting.
    return [];
  }
  const claudeProfiles = profiles.filter(
    (profile) => profile.config.kind === 'cli' && profile.config.tool === 'claude-code',
  );
  if (claudeProfiles.length === 0) return [];
  const missing = LINUX_SANDBOX_PROGRAMS.filter((program) => !host.isOnPath(program));
  const metadata = { tool: 'claude-code', required: [...LINUX_SANDBOX_PROGRAMS], missing };
  if (missing.length === 0) {
    return [
      {
        id: 'runners.sandbox.claude-code',
        severity: 'ok',
        summary: 'Claude Code sandbox programs bwrap and socat are on PATH.',
        metadata,
      },
    ];
  }
  const severity = claudeProfiles.some((profile) => profile.isDefault) ? 'blocker' : 'warning';
  return [
    {
      id: 'runners.sandbox.claude-code',
      severity,
      summary: `Claude Code sandbox cannot start: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not on PATH.`,
      details: [
        "The claude-code implementer runs its shell commands in Claude Code's sandbox. Without it the seat stops at startup instead of running them unconfined.",
      ],
      fix: SANDBOX_FIX,
      ...(severity === 'blocker' && { nextAction: 'prepare-runner' as const }),
      metadata,
    },
  ];
}
