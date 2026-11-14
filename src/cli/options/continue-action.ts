import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { SeatSwapCandidate } from '../../core/schemas/recovery/schemas.js';
import { cliError } from '../errors.js';
import { parseSeatSpecOption, parseEffortLevel } from './seat-spec.js';

export type RecoveryActionOption = Readonly<{
  action: Extract<
    RecoveryAction,
    | 'skip-current-task'
    | 'retry-same-worker'
    | 'restore-backup'
    | 'switch-seat'
    | 'accept-as-is'
    | 'end-run'
  >;
  candidate?: SeatSwapCandidate;
}>;

export type ContinueActionOption =
  | RecoveryActionOption
  | Readonly<{ action: 'apply' }>
  | Readonly<{ action: 'apply-as-is' }>
  | Readonly<{ action: 'discard' }>;

/**
 * `skip`, `retry`, `restore`, `switch-seat:<tool>[:<model>][@<effort>]` and `accept-as-is` answer a
 * pending recovery; `restore` puts back the checkout files a partial Apply replaced.
 * `end-run` closes the run. `apply`, `apply-as-is` and `discard` settle a run that is ready to
 * apply; `apply-as-is` applies a run that was accepted as is.
 */
export function parseContinueActionOption(value: string): ContinueActionOption {
  const spec = value.trim();
  if (spec === 'skip') return { action: 'skip-current-task' };
  if (spec === 'retry') return { action: 'retry-same-worker' };
  if (spec === 'restore') return { action: 'restore-backup' };
  if (spec === 'accept-as-is') return { action: 'accept-as-is' };
  if (spec === 'end-run') return { action: 'end-run' };
  if (spec === 'apply') return { action: 'apply' };
  if (spec === 'apply-as-is') return { action: 'apply-as-is' };
  if (spec === 'discard') return { action: 'discard' };
  if (spec.startsWith('switch-seat:')) {
    const seat = parseSeatSpecOption(spec.slice('switch-seat:'.length));
    const effort = seat.effort === undefined ? undefined : parseEffortLevel(seat.effort, value);
    return {
      action: 'switch-seat',
      candidate: {
        tool: seat.tool,
        ...(seat.model !== undefined && { model: seat.model }),
        ...(seat.variant !== undefined && { variant: seat.variant }),
        ...(effort !== undefined && { effort }),
      },
    };
  }
  throw cliError(
    `'${value}' is not a continue action. Use skip, retry, restore, switch-seat:<tool>[:<model>][@<effort>], accept-as-is, end-run, apply, apply-as-is, or discard.`,
    2,
  );
}
