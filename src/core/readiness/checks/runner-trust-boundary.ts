import type { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../config/accessors/reviewer-runner.js';
import type { RunnerConfigSlot } from '../../config/accessors/runner-config.js';
import { CREW_SEAT_LABELS, formatSlotLabel } from '../../crew/identity.js';
import { PICKER_ROLE_SEAT_IDS, runnerRoleForActiveRole } from '../../runners/seat-roles.js';
import { getRunnerTrustMeta } from '../../runners/trust.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import {
  DEFAULT_REDACTION_MARKER,
  isCredentialEnvironmentName,
  redactSecrets,
} from '../../../utils/redact.js';

type Seat = Readonly<{
  slot: RunnerConfigSlot;
  runner: Config['planner'] | Config['implementer'];
}>;

function crewSeats(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): Seat[] {
  const reviewer = resolveReviewerRunner(config);
  return [
    { slot: { role: 'planner' }, runner: config.planner },
    ...profiles.map((profile) => ({
      slot: { role: 'implementer', profile: profile.name } as const,
      runner: profile.config,
    })),
    ...(reviewer.source === 'configured'
      ? [{ slot: { role: 'reviewer' } as const, runner: reviewer.runner }]
      : []),
  ];
}

// Local permissions are informational; a declared command warns because Crew can replace it.
export function buildRunnerTrustBoundaryChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const commandSeats = crewSeats(config, profiles).filter(
    (seat) =>
      getRunnerTrustMeta(runnerRoleForActiveRole(seat.slot.role), seat.runner).executesLocalCommand,
  );
  if (commandSeats.length === 0) return [];
  return [
    {
      id: 'runners.trust-boundary',
      severity: 'info',
      summary: 'Your coding tools run commands on this machine with your permissions.',
      details: [
        'Writes to protected files ask for confirmation. Neither that nor plan approval limits the commands or network access of your coding tools.',
      ],
    },
    ...commandSeats.flatMap(declaredCommandCheck),
  ];
}

function declaredCommandCheck(seat: Seat): ReadinessCheck[] {
  if (seat.runner.kind !== 'shell' && seat.runner.kind !== 'agent') return [];
  const label = formatSlotLabel(seat.slot);
  return [
    {
      id: `runners.${seat.slot.role}.trust-boundary`,
      severity: 'warning',
      summary: `${label} runs a command you declared, with your permissions on this machine.`,
      details: [`Command: ${declaredCommandLine(seat.runner)}`],
      fix: `Review the command and its arguments in .splitbrief/config.yaml, or choose a coding tool in Settings > Crew > ${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[seat.slot.role]]}.`,
      metadata: {
        role: seat.slot.role,
        ...(seat.slot.role === 'implementer' && { profile: seat.slot.profile }),
        kind: seat.runner.kind,
      },
    },
  ];
}

/**
 * The declared command line is the whole disclosure, so it is printed in full:
 * control-stripped first so it cannot repaint the report or hide a credential
 * from the redactor, then redacted. `redactSecrets` sees one argument at a
 * time, so the value after a credential-named flag is withheld by position.
 */
function declaredCommandLine(runner: Extract<Seat['runner'], { kind: 'shell' | 'agent' }>): string {
  const argv = runner.args ?? [];
  return [
    safeCommandText(runner.command),
    ...argv.map((value, index) => {
      const flag = argv[index - 1];
      return flag !== undefined && isCredentialEnvironmentName(flag.replace(/^-+/, ''))
        ? DEFAULT_REDACTION_MARKER
        : safeCommandText(value);
    }),
  ].join(' ');
}

function safeCommandText(value: string): string {
  return redactSecrets(stripTerminalControls(value));
}
