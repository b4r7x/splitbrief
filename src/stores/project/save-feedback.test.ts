import { beforeEach, describe, expect, it } from 'vitest';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configError } from '../../core/config/errors.js';
import { feedbackStore } from '../ui/feedback.js';
import { reportConfigSaveFailure } from './save-feedback.js';

describe('reportConfigSaveFailure', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('names the field and the rule a refused document broke, not only where the save went', () => {
    const refused = configError.validationFailed('/project/.splitbrief/config.yaml', [
      'Configuration errors in .splitbrief/config.yaml:',
      '  planner.outputFormat: Configured outputFormat cannot replace the claude-code terminal contract.',
    ]);
    const failed = configError.saveFailed('/project/.splitbrief/config.yaml', refused);

    expect(reportConfigSaveFailure({ kind: 'failure', ok: false, error: failed })).toBe(true);
    expect(feedbackStore.get()).toEqual({
      message:
        'Failed to save config: planner.outputFormat: Configured outputFormat cannot replace the claude-code terminal contract.',
      isError: true,
    });
  });

  it('carries a write error through as it is', () => {
    const denied = new Error("EACCES: permission denied, open '/project/.splitbrief/config.yaml'");
    const failed = configError.saveFailed('/project/.splitbrief/config.yaml', denied);

    reportConfigSaveFailure({ kind: 'failure', ok: false, error: failed });

    expect(feedbackStore.get().message).toBe(
      "Failed to save config: EACCES: permission denied, open '/project/.splitbrief/config.yaml'",
    );
  });

  it('falls back to the failure itself when it has no cause', () => {
    reportConfigSaveFailure({ kind: 'failure', ok: false, error: new Error('disk full') });

    expect(feedbackStore.get().message).toBe('Failed to save config: disk full');
  });
});
