import { describe, expect, it } from 'vitest';
import { setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { recordResumeUserMessage } from './corrections.js';

describe('recordResumeUserMessage', () => {
  it('stores only expanded attachment messages, including after the first attachment', () => {
    const ref = setupProject();
    try {
      saveState(ref, createInitialState('feature'));
      const ts = '2026-10-10T00:00:00.000Z';
      const message = {
        ts,
        phase: 'planning' as const,
        displayText: 'Use @notes.md',
        text: 'Use @notes.md\n\nPELICAN-42 \n',
      };
      recordResumeUserMessage(ref, message);
      recordResumeUserMessage(ref, {
        ts,
        phase: 'planning',
        ...plainUserMessage('plain follow-up'),
      });
      expect(loadState(ref)?.resumeUserMessages).toEqual([message]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });
});
