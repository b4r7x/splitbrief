import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../stores/project/config.js';
import {
  deriveHomeHintLines,
  formatSubmissionFailure,
  noVisionFeedbackMessage,
} from './home-hint.js';

afterEach(() => configStore.reset());

const HINT = 'enter to send';

describe('formatSubmissionFailure', () => {
  it('names a file refusal and its remedy', () => {
    expect(
      formatSubmissionFailure({ ok: false, reason: 'not-found', path: '/outside/notes.md' }),
    ).toBe('Cannot send: file not found. Check the path and try again. File: notes.md.');
  });

  it('keeps the vision remedy when no planner config exists', () => {
    configStore.reset();
    expect(formatSubmissionFailure({ ok: false, reason: 'no-vision' })).toBe(
      'Cannot send image: the planner cannot see images. Choose a vision model with /crew plan.',
    );
  });

  it('names the configured plan seat in a vision refusal', () => {
    configStore.__testReset({ config: makeConfig({ planner: { kind: 'cli', tool: 'cursor' } }) });
    expect(formatSubmissionFailure({ ok: false, reason: 'no-vision' })).toMatch(
      /^Cannot attach: PLAN seat Cursor.* cannot see images — \/crew plan$/,
    );
  });
});

describe('deriveHomeHintLines', () => {
  it('renders nothing when the row is not reserved', () => {
    expect(
      deriveHomeHintLines({
        active: false,
        homeHint: HINT,
        feedbackMessage: 'hello',
        width: 80,
        dropEnabled: true,
      }),
    ).toEqual({ feedbackLine: null, homeHintLine: null });
  });

  it('adds the drop affordance only when it fits whole', () => {
    const wide = deriveHomeHintLines({
      active: true,
      homeHint: HINT,
      feedbackMessage: null,
      width: 80,
      dropEnabled: true,
    });
    expect(wide.homeHintLine).toContain('drop an image');

    const narrow = deriveHomeHintLines({
      active: true,
      homeHint: HINT,
      feedbackMessage: null,
      width: HINT.length + 2,
      dropEnabled: true,
    });
    expect(narrow.homeHintLine).toBe(HINT);
  });

  it('drops the affordance when the seat cannot see images', () => {
    expect(
      deriveHomeHintLines({
        active: true,
        homeHint: HINT,
        feedbackMessage: null,
        width: 80,
        dropEnabled: false,
      }).homeHintLine,
    ).toBe(HINT);
  });

  it('gives the row to feedback, keeping the known message readable when it must shrink', () => {
    const lines = deriveHomeHintLines({
      active: true,
      homeHint: HINT,
      feedbackMessage: noVisionFeedbackMessage('cursor · a-very-long-model-identity'),
      width: 60,
      dropEnabled: true,
    });
    expect(lines.homeHintLine).toBeNull();
    // The seat name is what shrinks; the sentence that says what to do survives whole.
    expect(lines.feedbackLine).toContain('cannot see images — /crew plan');
    expect(lines.feedbackLine).toContain('…');
  });
});
