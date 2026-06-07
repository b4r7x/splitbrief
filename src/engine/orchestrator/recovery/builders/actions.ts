import type { RecoveryAction } from '../../../../core/schemas/enums.js';
import { PROMPTABLE_RECOVERY_ACTIONS } from '../../../../core/schemas/enums.js';
import type { UserEditConflict } from '../../../events/workflow-events.js';

const ACTION_ORDER = PROMPTABLE_RECOVERY_ACTIONS;

export function orderedActions(actions: Array<RecoveryAction | undefined>): RecoveryAction[] {
  const requested = new Set(actions.filter((action) => action !== undefined));
  return ACTION_ORDER.filter((action) => requested.has(action));
}

export function chooseRecommended(
  actions: RecoveryAction[],
  preferences: RecoveryAction[],
): RecoveryAction {
  for (const preference of preferences) {
    if (actions.includes(preference)) return preference;
  }
  return actions[0] ?? 'pause-run';
}

export function chooseUserEditRecommendation(
  conflict: UserEditConflict,
  actions: RecoveryAction[],
): RecoveryAction {
  if (conflict.safeToContinue && actions.includes('continue')) return 'continue';
  return chooseRecommended(actions, ['pause-run']);
}

export function hasRouteBigger(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): boolean {
  if (opts.canRouteBigger === false) return false;
  return opts.routeBiggerProfile !== undefined || opts.canRouteBigger === true;
}
