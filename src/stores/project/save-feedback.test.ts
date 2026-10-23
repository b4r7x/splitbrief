import { beforeEach, describe, expect, it } from 'vitest';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configError } from '../../core/config/errors.js';
import { feedbackStore } from '../ui/feedback.js';
import { formatConfigSaveSuccess, reportConfigSaveFailure } from './save-feedback.js';

describe('formatConfigSaveSuccess', () => {
  it('names the .gitignore edit on the save line that made it', () => {
    expect(formatConfigSaveSuccess('PLAN', { ignoreRuleAdded: true })).toBe(
      'Saved PLAN to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
    );
    expect(formatConfigSaveSuccess('PLAN', { ignoreRuleAdded: false })).toBe(
      'Saved PLAN to .splitbrief/config.yaml',
    );
  });
});

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

  it('keeps a one-line refusal whole', () => {
    const failed = configError.saveFailed(
      '/project/.splitbrief/config.yaml',
      configError.unsupportedVersion(2),
    );

    reportConfigSaveFailure({ kind: 'failure', ok: false, error: failed });

    expect(feedbackStore.get().message).toBe(
      'Failed to save config: Unsupported config version: 2. Supported: 3. Run `splitbrief init --reconfigure` to write a current config.',
    );
  });

  it('drops a later line that only introduces more lines', () => {
    const refused = configError.validationFailed('/project/.splitbrief/config.yaml', [
      'Configuration errors in .splitbrief/config.yaml:',
      '  planner: No runner kind matches; each kind needs:',
      '  planner.tool: Required',
      '  planner.command: Required',
    ]);
    const failed = configError.saveFailed('/project/.splitbrief/config.yaml', refused);

    reportConfigSaveFailure({ kind: 'failure', ok: false, error: failed });

    expect(feedbackStore.get().message).toBe(
      'Failed to save config: planner.tool: Required; planner.command: Required',
    );
  });

  it('falls back to the failure itself when it has no cause', () => {
    reportConfigSaveFailure({ kind: 'failure', ok: false, error: new Error('disk full') });

    expect(feedbackStore.get().message).toBe('Failed to save config: disk full');
  });
});
