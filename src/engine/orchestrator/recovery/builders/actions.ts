import { RECOVERY_ACTIONS, type RecoveryAction } from '../../../../core/schemas/enums.js';
import type { HaltAction, HaltOf } from '../../../../core/recovery/halt.js';
import type { RecoveryReason } from '../../../../core/schemas/enums.js';

/**
 * The actions one cause offers, in the order every halt lists them. The type admits only the
 * actions of the cause's halt, so a builder cannot offer what its halt does not; an `undefined`
 * entry is an action this issue cannot carry and is left out.
 */
export function haltActions<R extends RecoveryReason>(
  _reason: R,
  actions: ReadonlyArray<HaltAction<HaltOf<R>> | undefined>,
): RecoveryAction[] {
  const requested = new Set<RecoveryAction>(actions.filter((action) => action !== undefined));
  return RECOVERY_ACTIONS.filter((action) => requested.has(action));
}

/** The first preference the issue offers, else the least final action it lists. */
export function chooseRecommended(
  actions: readonly RecoveryAction[],
  preferences: readonly RecoveryAction[] = [],
): RecoveryAction {
  for (const preference of preferences) {
    if (actions.includes(preference)) return preference;
  }
  const [first] = actions;
  if (first === undefined) return 'end-run';
  return first;
}
