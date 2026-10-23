import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatNeedsSignInSaveFeedback } from '../../features/runners/picker-format.js';
import { configStore } from '../../stores/project/config.js';
import { formatConfigSaveSuccess } from '../../stores/project/save-feedback.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
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
      feedbackMessage: noVisionFeedbackMessage(
        `cursor · ${'a-very-long-model-identity'.repeat(8)}`,
      ),
      width: 60,
      dropEnabled: true,
    });
    expect(lines.homeHintLine).toBeNull();
    // The seat name is what shrinks; the sentence that says what to do survives whole.
    expect(lines.feedbackLine).toContain('cannot see images — /crew plan');
    expect(lines.feedbackLine).toContain('…');
  });

  it('keeps a notice on the row under feedback, without the drop affordance', () => {
    expect(
      deriveHomeHintLines({
        active: true,
        homeHint: HINT,
        notice: 'Checking your tools…',
        feedbackMessage: 'Attached: notes.md',
        width: 80,
        dropEnabled: true,
      }),
    ).toEqual({ feedbackLine: 'Attached: notes.md', homeHintLine: 'Checking your tools…' });
    expect(
      deriveHomeHintLines({
        active: true,
        homeHint: HINT,
        notice: 'Checking your tools…',
        feedbackMessage: null,
        width: 80,
        dropEnabled: true,
      }).homeHintLine,
    ).toBe('Checking your tools… · drop an image');
  });

  // Home is 108 cells wide at 120 columns, 76 at 80 and 56 at 60.
  it.each([
    [108, 2],
    [76, 3],
    [56, 4],
  ])('shows the whole sign-in step of a save message at width %i on %i rows', (width, rows) => {
    const message = [
      formatConfigSaveSuccess('BUILD · OpenCode CLI · Claude Haiku 4.5 · via anthropic', {
        ignoreRuleAdded: false,
      }),
      formatNeedsSignInSaveFeedback({ tool: 'opencode', provider: 'anthropic' }),
    ].join(SOFT_SEP);

    const { feedbackLine } = deriveHomeHintLines({
      active: true,
      homeHint: HINT,
      feedbackMessage: message,
      width,
      dropEnabled: true,
    });

    const shown = feedbackLine?.split('\n') ?? [];
    expect(shown).toHaveLength(rows);
    for (const row of shown) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(width);
    expect(shown.join(' ')).toBe(message);
    expect(shown.some((row) => row.includes('run opencode auth login anthropic'))).toBe(true);
  });

  it('ends a home feedback on the file name it shortened, not on a stub of the next part', () => {
    const { feedbackLine } = deriveHomeHintLines({
      active: true,
      homeHint: HINT,
      feedbackMessage:
        'Could not release the run lock: permission denied · .splitbrief/sessions/2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds',
      width: 24,
      dropEnabled: true,
    });

    expect(feedbackLine?.split('\n')).toEqual([
      'Could not release',
      'the run lock:',
      'permission denied ·',
      '…/lockfile.json …',
    ]);
  });

  it('keeps a short message on one row', () => {
    expect(
      deriveHomeHintLines({
        active: true,
        homeHint: HINT,
        feedbackMessage: 'Attached: notes.md',
        width: 56,
        dropEnabled: true,
      }).feedbackLine,
    ).toBe('Attached: notes.md');
  });
});
