import { describe, expect, it } from 'vitest';
import { USER_EDIT_CONFLICT_ACTIONS } from '../schemas/enums.js';
import { userEditActionToRecoveryAction } from './user-edit-actions.js';

describe('userEditActionToRecoveryAction', () => {
  it('maps every conflict action to a recovery action', () => {
    expect(userEditActionToRecoveryAction('continue-unrelated')).toBe('continue');
    expect(userEditActionToRecoveryAction('pause')).toBe('pause-run');
    expect(userEditActionToRecoveryAction('skip-current-task')).toBe('skip-current-task');
    expect(userEditActionToRecoveryAction('abort-workflow')).toBe('abort-workflow');
  });

  it('no longer offers the removed regenerate-rebase action', () => {
    expect(USER_EDIT_CONFLICT_ACTIONS).not.toContain('regenerate-rebase');
  });
});
