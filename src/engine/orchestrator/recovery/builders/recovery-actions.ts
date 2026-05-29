import type { RecoveryAction } from '../../../../core/schemas/enums.js';
import type { UserEditConflict, UserEditConflictAction } from '../../../events/workflow-events.js';

const ACTION_ORDER: RecoveryAction[] = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
];

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
  return chooseRecommended(actions, ['planner-split-rebase', 'pause-run']);
}

export function mapUserEditAction(action: UserEditConflictAction): RecoveryAction {
  if (action === 'continue-unrelated') return 'continue';
  if (action === 'regenerate-rebase') return 'planner-split-rebase';
  if (action === 'pause') return 'pause-run';
  return action;
}

export function hasRouteBigger(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): boolean {
  if (opts.canRouteBigger === false) return false;
  return opts.routeBiggerProfile !== undefined || opts.canRouteBigger === true;
}
