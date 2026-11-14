import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import {
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
  formatSeatIdentity,
} from '../../../core/crew/identity.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { routeNoCredential, routeSignInCommand } from '../../../core/runners/route-auth.js';
import type { PickerSlot, SeatPickerRole } from '../../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { PickerOption } from '../model-catalog/options.js';
import type { RunnerPermissionPosture } from '../model-catalog/posture.js';
import type { PickerOptionStatus } from '../model-catalog/status.js';
import type { TerminalPane } from '../two-column-picker/types.js';

/**
 * The launcher's card is a fixed-height read-only pane, so a line written to its narrowest draw
 * never takes a second row: at 60 columns the overlay is 56 cells wide, the
 * Models box takes 27 of them and its padding and border spend 4, leaving these.
 */
export const CUSTOM_COMMAND_PANE_CELLS = 23;

/**
 * What the launcher row promises: the action, the two contracts it chooses between, the two steps
 * Enter opens and the fact that neither of them has written anything yet. The seat is not repeated
 * here — the picker's title names it one row above the card — and neither is the configured
 * command, which the row under the cursor already spells.
 */
export const CUSTOM_COMMAND_PANE_LINES: readonly string[] = [
  'Run your own command.',
  '',
  `output${SOFT_SEP}reads stdout`,
  `direct${SOFT_SEP}writes files`,
  '',
  '⏎ picks the contract,',
  'then the command.',
  'Nothing is saved yet.',
];

export function fallbackInheritanceNotice(
  input: Readonly<{ slot: PickerSlot; role: SeatPickerRole; inherited: boolean }>,
): string | undefined {
  return input.slot === 'fallback' && input.role === 'reviewer' && input.inherited
    ? `${CREW_SEAT_LABELS.review} ${PLANNER_INHERITANCE.mark}${SOFT_SEP}saving here gives REVIEW its own seat`
    : undefined;
}

export function isPickerItemDisabled(item: PickerOption): boolean {
  if (
    item.kind === 'custom-command' ||
    item.kind === 'no-fallback' ||
    item.kind === 'review-none'
  ) {
    return false;
  }
  return !item.available;
}

export function formatPickerStatusLabel(status: PickerOptionStatus): string | undefined {
  switch (status.state) {
    case 'ready':
      return undefined;
    case 'unavailable':
      return 'Unavailable';
    case 'unauthenticated':
      return 'Auth required';
    case 'incompatible':
      return 'Incompatible';
    case 'untrusted':
      return 'Untrusted';
    case 'unverified':
      return 'Unverified';
    case 'disabled':
      return 'Disabled';
    default:
      return assertNever(status);
  }
}

export function notReadyPane(input: {
  status: PickerOptionStatus;
  savedRunner: RunnerConfig | undefined;
}): TerminalPane | undefined {
  const title = formatPickerStatusLabel(input.status);
  if (title === undefined || input.status.remediation === null) return undefined;
  const lines: TerminalPane['lines'] = [
    input.status.remediation,
    '',
    'Its models show here when it is ready.',
  ];
  if (input.savedRunner !== undefined) {
    lines.push('', 'Saved choice:', { whole: formatSeatIdentity({ seat: input.savedRunner }) });
  }
  return { label: title, lines };
}

/** The sandbox posture leads: it is the one label that differs between tools, and a byline sheds from the end. */
export function formatPermissionLabels(permissions: RunnerPermissionPosture): string[] {
  const labels: string[] = [];
  if (permissions.sandbox === 'cli-managed') labels.push('cli sandbox');
  else if (permissions.sandbox === 'mode-dependent') labels.push('sandbox varies');
  if (permissions.directWrite) labels.push('direct write');
  if (permissions.network) labels.push('network');
  if (permissions.shell) labels.push('shell');
  if (permissions.automaticApproval) labels.push('auto approval');
  return labels;
}

/** The note a saved route with no credential adds to the save message, in doctor's and the halt's words. */
export function formatNeedsSignInSaveFeedback(input: {
  tool: CliToolId;
  provider: string;
}): string {
  return `${routeNoCredential(input.tool, input.provider)} — run ${routeSignInCommand(input.tool, input.provider)} before start`;
}
