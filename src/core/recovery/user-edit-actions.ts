import type { RecoveryAction, UserEditConflictAction } from '../schemas/enums.js';
import { assertNever } from '../../utils/type-guards.js';

export function userEditActionToRecoveryAction(action: UserEditConflictAction): RecoveryAction {
  switch (action) {
    case 'continue-unrelated':
      return 'continue';
    case 'pause':
      return 'pause-run';
    case 'skip-current-task':
      return 'skip-current-task';
    case 'abort-workflow':
      return 'abort-workflow';
    default:
      return assertNever(action);
  }
}
