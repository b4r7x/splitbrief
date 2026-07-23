import { describe, expect, it } from 'vitest';
import { userEditActionToRecoveryAction } from './user-edit-actions.js';

describe('userEditActionToRecoveryAction', () => {
  it('maps every conflict action to a recovery action', () => {
    expect(userEditActionToRecoveryAction('continue-unrelated')).toBe('continue');
    expect(userEditActionToRecoveryAction('pause')).toBe('pause-run');
    expect(userEditActionToRecoveryAction('skip-current-task')).toBe('skip-current-task');
    expect(userEditActionToRecoveryAction('abort-workflow')).toBe('abort-workflow');
  });
});
