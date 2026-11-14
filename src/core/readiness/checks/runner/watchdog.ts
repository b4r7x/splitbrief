import type { resolveImplementerProfiles } from '../../../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../config/accessors/reviewer-runner.js';
import { formatSlotLabel } from '../../../crew/identity.js';
import type { Config } from '../../../schemas/config.js';
import type { SeatNamer, ReadinessCheck } from '../../types.js';

export function buildWatchdogTimeoutChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
  nameSeat: SeatNamer,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(
    ...watchdogTimeoutCheck({
      id: 'runners.planner.timeout-disables-watchdog',
      label: `${formatSlotLabel({ role: 'planner' })} ${nameSeat(config.planner, 'planner')}`,
      runner: config.planner,
    }),
  );

  for (const profile of profiles) {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.implementer.timeout-disables-watchdog',
        label: `${formatSlotLabel({ role: 'implementer', profile: profile.name })} ${nameSeat(profile.config, 'implementer')}`,
        runner: profile.config,
      }),
    );
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.reviewer.timeout-disables-watchdog',
        label: `${formatSlotLabel({ role: 'reviewer' })} ${nameSeat(reviewer.runner, 'reviewer')}`,
        runner: reviewer.runner,
      }),
    );
  }

  return checks;
}

function watchdogTimeoutCheck(opts: {
  id: string;
  label: string;
  runner: Config['planner'] | Config['implementer'];
}): ReadinessCheck[] {
  if (opts.runner.kind === 'api') return [];

  const { timeout, idleKillMs } = opts.runner;
  if (timeout === undefined || idleKillMs === undefined) return [];
  if (timeout > idleKillMs) return [];

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: `${opts.label} timeout (${timeout}ms) is at or below the idle-kill threshold (${idleKillMs}ms); the watchdog kill-and-retry never gets a chance to fire.`,
      fix: `Raise or remove the timeout for ${opts.label}.`,
      metadata: {
        timeout,
        idleKillMs,
      },
    },
  ];
}
