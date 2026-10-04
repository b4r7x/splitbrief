import type { RecoveryAction, RecoveryReason } from '../../../../core/schemas/enums.js';
import { PROMPTABLE_RECOVERY_ACTIONS } from '../../../../core/schemas/enums.js';
import { allowedActionsForReason } from '../../../../core/schemas/recovery/policy.js';

const ACTION_ORDER = PROMPTABLE_RECOVERY_ACTIONS;

export function orderedActions(actions: Array<RecoveryAction | undefined>): RecoveryAction[] {
  const requested = new Set(actions.filter((action) => action !== undefined));
  return ACTION_ORDER.filter((action) => requested.has(action));
}

/**
 * What one issue can actually offer: the policy's actions for its reason, minus
 * the two that need something this issue may not carry — `switch-seat` a seat to
 * move to, `route-bigger-worker` a profile to route to. An action the operator
 * picks only to be refused is worse than one the panel never showed, and a
 * literal beside a builder that subtracts anything else is a second policy.
 */
export function availableActionsForReason(
  reason: RecoveryReason,
  offers: { switchSeat: boolean; routeBigger: boolean },
): RecoveryAction[] {
  return orderedActions(
    allowedActionsForReason(reason).filter((action) => {
      if (action === 'switch-seat') return offers.switchSeat;
      if (action === 'route-bigger-worker') return offers.routeBigger;
      return true;
    }),
  );
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

export function hasRouteBigger(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): boolean {
  if (opts.canRouteBigger === false) return false;
  return opts.routeBiggerProfile !== undefined || opts.canRouteBigger === true;
}
