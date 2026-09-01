import { describe, expect, it } from 'vitest';
import { deriveHomeHintLines, noVisionFeedbackMessage } from './home-hint.js';

const HINT = 'enter to send';

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
      feedbackMessage: noVisionFeedbackMessage('claude-code · a-very-long-model-identity'),
      width: 60,
      dropEnabled: true,
    });
    expect(lines.homeHintLine).toBeNull();
    // The seat name is what shrinks; the sentence that says what to do survives whole.
    expect(lines.feedbackLine).toContain('cannot see images — /crew plan');
    expect(lines.feedbackLine).toContain('…');
  });
});
