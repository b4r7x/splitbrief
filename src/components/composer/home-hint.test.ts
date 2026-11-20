import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatNeedsSignInSaveFeedback } from '../../features/runners/picker/labels.js';
import { configStore } from '../../stores/project/config.js';
import { formatConfigSaveSuccess } from '../../stores/project/save-feedback.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import {
  deriveHomeHintLine,
  formatSubmissionFailure,
  layoutHomeNotice,
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

const LINE = {
  active: true,
  homeHint: HINT,
  status: undefined,
  notice: undefined,
  noticeShown: false,
  width: 80,
  dropEnabled: true,
} as const;

describe('deriveHomeHintLine', () => {
  it('renders nothing when the row is not reserved', () => {
    expect(deriveHomeHintLine({ ...LINE, active: false })).toBeNull();
  });

  it('adds the drop affordance only when it fits whole', () => {
    expect(deriveHomeHintLine(LINE)).toBe(`${HINT} · drop an image`);
    expect(deriveHomeHintLine({ ...LINE, width: HINT.length + 2 })).toBe(HINT);
  });

  it('drops the affordance when the seat cannot see images', () => {
    expect(deriveHomeHintLine({ ...LINE, dropEnabled: false })).toBe(HINT);
  });

  it('gives the hint up under a notice, but keeps a check the user waits on, without the drop', () => {
    expect(deriveHomeHintLine({ ...LINE, noticeShown: true })).toBeNull();
    expect(deriveHomeHintLine({ ...LINE, noticeShown: true, status: 'Checking PLAN…' })).toBe(
      'Checking PLAN…',
    );
    expect(deriveHomeHintLine({ ...LINE, noticeShown: true, notice: 'Checking your tools…' })).toBe(
      'Checking your tools…',
    );
  });

  it('puts a running check on the line in place of the hint', () => {
    expect(deriveHomeHintLine({ ...LINE, notice: 'Checking your tools…' })).toBe(
      'Checking your tools… · drop an image',
    );
  });
});

describe('layoutHomeNotice', () => {
  it('keeps the known message readable when it must shrink', () => {
    const notice = layoutHomeNotice(
      {
        message: noVisionFeedbackMessage(`cursor · ${'a-very-long-model-identity'.repeat(8)}`),
        severity: 'warning',
      },
      60,
    );
    const text = notice.rows.join('');
    // The seat name is what shrinks; the sentence that says what to do survives whole.
    expect(text).toContain('cannot see images — /crew plan');
    expect(text).toContain('…');
  });

  // Home is 108 cells wide at 120 columns, 76 at 80 and 56 at 60.
  it.each([
    [108, 2, 'framed'],
    [76, 3, 'framed'],
    [56, 4, 'bars'],
  ] as const)(
    'shows the whole sign-in step of a save message at width %i on %i rows',
    (width, rows, form) => {
      const message = [
        formatConfigSaveSuccess('BUILD · OpenCode CLI · Claude Haiku 4.5 · via anthropic', {
          ignoreRuleAdded: false,
        }),
        formatNeedsSignInSaveFeedback({ tool: 'opencode', provider: 'anthropic' }),
      ].join(SOFT_SEP);

      const notice = layoutHomeNotice({ message, severity: 'warning' }, width);

      expect(notice.form).toBe(form);
      expect(notice.rows).toHaveLength(rows);
      expect(notice.width).toBeLessThanOrEqual(width);
      for (const row of notice.rows)
        expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(width - 6);
      expect(notice.rows.join(' ')).toBe(message);
      expect(notice.rows.some((row) => row.includes('run opencode auth login anthropic'))).toBe(
        true,
      );
    },
  );

  it('ends a notice on the file name it shortened, not on a stub of the next part', () => {
    const notice = layoutHomeNotice(
      {
        message:
          'Could not release the run lock: permission denied · .splitbrief/sessions/2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds',
        severity: 'error',
      },
      30,
    );

    expect(notice.rows).toEqual([
      'Could not release',
      'the run lock:',
      'permission denied ·',
      '…/lockfile.json …',
    ]);
  });

  it('frames a short message on one row, as wide as its words', () => {
    expect(layoutHomeNotice({ message: 'Attached: notes.md', severity: 'info' }, 56)).toEqual({
      severity: 'info',
      form: 'framed',
      rows: ['Attached: notes.md'],
      width: 22,
      height: 3,
    });
  });
});
