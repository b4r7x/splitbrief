import { describe, expect, it } from 'vitest';
import { elidePathMiddle, getTerminalCellWidth } from '../../utils/display-text.js';
import { wrapHard } from '../../utils/wrap.js';
import { fitFeedbackMessage } from './feedback-fit.js';

const E_ACUTE = 'e\u0301';
const FAMILY = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
const THUMBS_UP_MEDIUM = '\u{1F44D}\u{1F3FD}';
const FLAG_PL = '\u{1F1F5}\u{1F1F1}';
const PREFIX = 'Run "';
const SUFFIX = '" failed';

const clusters = [
  { name: 'a combining mark', cluster: E_ACUTE, cells: 1 },
  { name: 'a ZWJ family emoji', cluster: FAMILY, cells: 2 },
  { name: 'a skin-tone modifier', cluster: THUMBS_UP_MEDIUM, cells: 2 },
  { name: 'a flag pair', cluster: FLAG_PL, cells: 2 },
];

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeBoundaries(text: string): Set<number> {
  const ends = Array.from(
    graphemeSegmenter.segment(text),
    (part) => part.index + part.segment.length,
  );
  return new Set([0, ...ends]);
}

/** The cut keeps a prefix of `source` that ends on a grapheme boundary, then an ellipsis. */
function expectWholeGraphemeCut(source: string, fitted: string, width: number): void {
  expect(fitted.endsWith('…')).toBe(true);
  const head = fitted.slice(0, -1);
  expect(source.startsWith(head)).toBe(true);
  expect(graphemeBoundaries(source).has(head.length)).toBe(true);
  expect(head).not.toMatch(/\u200d$/u);
  expect(head).not.toMatch(/[\ud800-\udbff]$/);
  if (head.endsWith('\u0301')) expect(head.endsWith(E_ACUTE)).toBe(true);
  expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
  expect(wrapHard(fitted, width)).not.toContain('\n');
}

function titleHead(fitted: string): string {
  expect(fitted.startsWith(PREFIX)).toBe(true);
  expect(fitted.endsWith(SUFFIX)).toBe(true);
  return fitted.slice(PREFIX.length, fitted.length - SUFFIX.length);
}

describe('fitFeedbackMessage', () => {
  it('leaves short feedback unchanged', () => {
    expect(
      fitFeedbackMessage('Cannot resume "alpha": missing state', { width: 80, maxRows: 1 }),
    ).toBe('Cannot resume "alpha": missing state');
  });

  it('leaves normal structured feedback unchanged when it fits', () => {
    expect(
      fitFeedbackMessage(
        {
          prefix: 'Cannot resume "',
          title: 'alpha',
          suffix: '": interrupted before it made progress — start it again.',
        },
        { width: 80, maxRows: 1 },
      ),
    ).toBe('Cannot resume "alpha": interrupted before it made progress — start it again.');
  });

  it('truncates the quoted session title while preserving the actionable suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'prosze pokaz mi ze to dziala po prostu zrob test nic wiecej nie chce od ciebie',
        suffix: '": interrupted before it made progress — start it again.',
      },
      { width: 100, maxRows: 1 },
    );

    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted).toContain('Cannot resume "prosze');
    expect(fitted).toContain('": interrupted before it made progress — start it again.');
    expect(fitted).toContain('…');
    expect(fitted).not.toContain('nie chce od ciebie');
  });

  it('truncates wide-character titles by display width while preserving the suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Session "',
        title: '功能'.repeat(8),
        suffix: '" failed without a summary to display',
      },
      { width: 55, maxRows: 1 },
    );

    expect(fitted).toBe('Session "功能功能…" failed without a summary to display');
  });

  it('falls back to whole-message truncation when the suffix alone is too wide', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'very long title',
        suffix: '": interrupted before it made progress — start it again.',
      },
      { width: 24, maxRows: 1 },
    );

    expect(fitted.length).toBeLessThanOrEqual(24);
    expect(fitted).toContain('…');
  });

  describe.each(clusters)('with $name at the cut', ({ cluster, cells }) => {
    const source = `aaaaa${cluster}${'b'.repeat(10)}`;
    const keptWidth = 5 + cells + 1;

    it('keeps the cluster whole when it fits before the ellipsis', () => {
      const fitted = fitFeedbackMessage(source, { width: keptWidth, maxRows: 1 });

      expect(fitted).toBe(`aaaaa${cluster}…`);
      expectWholeGraphemeCut(source, fitted, keptWidth);
    });

    it('cuts before the whole cluster when it does not fit', () => {
      const fitted = fitFeedbackMessage(source, { width: keptWidth - 1, maxRows: 1 });

      expect(fitted).toBe('aaaaa…');
      expectWholeGraphemeCut(source, fitted, keptWidth - 1);
    });

    it('keeps the cluster whole in a title when it fits before the ellipsis', () => {
      const width = PREFIX.length + SUFFIX.length + keptWidth;
      const fitted = fitFeedbackMessage(
        { prefix: PREFIX, title: source, suffix: SUFFIX },
        { width, maxRows: 1 },
      );

      expect(fitted).toBe(`${PREFIX}aaaaa${cluster}…${SUFFIX}`);
      expectWholeGraphemeCut(source, titleHead(fitted), keptWidth);
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
    });

    it('cuts a title before the whole cluster when it does not fit', () => {
      const width = PREFIX.length + SUFFIX.length + keptWidth - 1;
      const fitted = fitFeedbackMessage(
        { prefix: PREFIX, title: source, suffix: SUFFIX },
        { width, maxRows: 1 },
      );

      expect(fitted).toBe(`${PREFIX}aaaaa…${SUFFIX}`);
      expectWholeGraphemeCut(source, titleHead(fitted), keptWidth - 1);
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
    });

    it('never splits the cluster at any width', () => {
      const repeated = `${cluster}${cluster}a${cluster}${'z'.repeat(12)}`;
      for (let width = 2; width <= 12; width++) {
        expectWholeGraphemeCut(
          repeated,
          fitFeedbackMessage(repeated, { width, maxRows: 1 }),
          width,
        );
        const titleWidth = PREFIX.length + SUFFIX.length + width;
        const fitted = fitFeedbackMessage(
          { prefix: PREFIX, title: repeated, suffix: SUFFIX },
          { width: titleWidth, maxRows: 1 },
        );
        expectWholeGraphemeCut(repeated, titleHead(fitted), width);
      }
    });
  });

  it('keeps tabs and escape sequences in the kept text', () => {
    const tabbed = `tab\there ${'x'.repeat(30)}`;
    const colored = `a\u001b[31mred\u001b[0m ${'x'.repeat(30)}`;

    expect(fitFeedbackMessage(tabbed, { width: 12, maxRows: 1 })).toBe('tab\there xx…');
    expect(fitFeedbackMessage(colored, { width: 12, maxRows: 1 })).toBe(
      'a\u001b[31mred\u001b[0m xxxxxx…',
    );
  });

  it('cuts at the first line break, which never fits one row', () => {
    expect(fitFeedbackMessage('first\nsecond', { width: 80, maxRows: 1 })).toBe('first…');
    expect(fitFeedbackMessage(`${E_ACUTE}\nsecond`, { width: 80, maxRows: 1 })).toBe(`${E_ACUTE}…`);
  });

  it('wraps a long message at word boundaries onto even rows, cutting nothing', () => {
    const message = 'one two three four five six seven eight nine';

    expect(fitFeedbackMessage(message, { width: 20, maxRows: 3 }).split('\n')).toEqual([
      'one two three',
      'four five six',
      'seven eight nine',
    ]);
  });

  it('never evens the rows out by cutting a word that fits one row whole', () => {
    const path = '.splitbrief/sessions/2026-10-22-add-a-greeting-helper/draft.json';
    const rows = fitFeedbackMessage(`Draft not saved: permission denied · ${path} · quit again`, {
      width: 80,
      maxRows: 4,
    }).split('\n');

    expect(rows.some((row) => row.includes(path))).toBe(true);
  });

  it.each([
    '2026-10-22-add-a-greeting-helper-to-the-cli-entry-point-docs',
    '2026-10-22-make-the-closed-transcript-block-say-the-run-outcome',
  ])('keeps the session id %s whole on one row of 4 at any home width', (id) => {
    const message = `Draft not saved: permission denied · .splitbrief/sessions/${id}/draft.json · quit again leaves without it`;
    for (let width = 64; width <= 78; width++) {
      const rows = fitFeedbackMessage(message, { width, maxRows: 4 }).split('\n');

      expect(rows.length).toBeLessThanOrEqual(4);
      expect(rows.some((row) => row.includes(id))).toBe(true);
      expect(rows.at(-1)?.endsWith('quit again leaves without it')).toBe(true);
      for (const row of rows) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  it.each([
    'Draft not saved: permission denied · .splitbrief/sessions/2026-10-22-add-a-greeting-helper-to-the-cli-entry-point-docs/draft.json · quit again leaves without it',
    'Saved BUILD · OpenCode CLI · Claude Haiku 4.5 · via anthropic to .splitbrief/config.yaml · OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start',
  ])('keeps each separator on the row of the text before it: %s', (message) => {
    for (let width = 40; width <= 114; width++) {
      const fitted = fitFeedbackMessage(message, { width, maxRows: 4 });

      expect(fitted.split('\n').filter((row) => row.startsWith('·'))).toEqual([]);
      if (!fitted.includes('…')) expect(fitted.replace(/\s/g, '')).toBe(message.replace(/\s/g, ''));
    }
  });

  it('keeps a message that fits one row on one row', () => {
    expect(fitFeedbackMessage('one two three', { width: 20, maxRows: 3 })).toBe('one two three');
  });

  it('puts the ellipsis on the last allowed row only when the rows run out', () => {
    const rows = fitFeedbackMessage('one two three four five six seven eight nine', {
      width: 20,
      maxRows: 2,
    }).split('\n');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('one two three four');
    expect(rows[1]?.endsWith('…')).toBe(true);
    for (const row of rows) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(20);
  });

  describe('a message that names a path', () => {
    const SESSION = '2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-';
    const LOCK = `.splitbrief/sessions/${SESSION}/lockfile.json`;
    const STATE = `.splitbrief/sessions/${SESSION}/state.json`;
    const RELEASE = `Could not release the run lock: permission denied · ${LOCK} · other SPLITBRIEF processes can see the run as running for a few more seconds`;

    it.each([
      [116, 'Could not release the run lock: permission denied · .splitbrief/…/lockfile.json …'],
      [76, 'Could not release the run lock: permission denied · …/lockfile.json …'],
      [68, 'Could not release the run lock: permission denied · …/lockfile.json'],
    ])('keeps the file name on one row of %i cells and drops the parts after it', (width, row) => {
      const fitted = fitFeedbackMessage(RELEASE, { width, maxRows: 1 });

      expect(fitted).toBe(row);
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
    });

    it('cuts the end as before when the whole path fits', () => {
      expect(fitFeedbackMessage(RELEASE, { width: 151, maxRows: 1 })).toBe(
        `${RELEASE.slice(0, 150)}…`,
      );
    });

    it('keeps each whole part that fits after a shortened path', () => {
      const message = RELEASE.replace(`${LOCK} · `, `${LOCK} · retry · `);

      expect(fitFeedbackMessage(message, { width: 116, maxRows: 1 })).toBe(
        'Could not release the run lock: permission denied · .splitbrief/…/lockfile.json · retry …',
      );
    });

    it('drops a path whose file name cannot follow the cause', () => {
      expect(fitFeedbackMessage(RELEASE, { width: 56, maxRows: 1 })).toBe(
        'Could not release the run lock: permission denied …',
      );
    });

    it('cuts the end as before when not even the cause and the ellipsis fit', () => {
      expect(fitFeedbackMessage(RELEASE, { width: 50, maxRows: 1 })).toBe(
        `${RELEASE.slice(0, 49)}…`,
      );
    });

    it('shortens a path at the end of the message and cuts nothing else', () => {
      const message = `Could not save the run state: permission denied · ${STATE}`;

      expect(fitFeedbackMessage(message, { width: 76, maxRows: 1 })).toBe(
        'Could not save the run state: permission denied · .splitbrief/…/state.json',
      );
    });

    it('shortens each of two paths, left to right, in the room the text before it leaves', () => {
      const message = `Could not copy · ${STATE} · .splitbrief/sessions/${SESSION}/run.patch`;

      expect(fitFeedbackMessage(message, { width: 80, maxRows: 1 })).toBe(
        'Could not copy · .splitbrief/…/state.json · .splitbrief/…/run.patch',
      );
    });

    it('does not take a part with a space for a path', () => {
      const message = `Could not read: permission denied · /Users/me/My Projects/app/${STATE}`;

      expect(fitFeedbackMessage(message, { width: 60, maxRows: 1 })).toBe(
        `${message.slice(0, 59)}…`,
      );
    });

    it('counts wide characters in cells when it gives the path its room', () => {
      const message = `无法保存运行状态: permission denied · ${STATE}`;

      expect(fitFeedbackMessage(message, { width: 61, maxRows: 1 })).toBe(
        '无法保存运行状态: permission denied · …/state.json',
      );
    });

    it('cuts the file name in its middle when not even the name fits', () => {
      const fitted = fitFeedbackMessage(LOCK, { width: 10, maxRows: 1 });

      expect(fitted).toBe(elidePathMiddle(LOCK, 10));
      expect(fitted).toContain('…');
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(10);
    });

    it('keeps the file name on a home feedback of four rows at a narrow width', () => {
      for (const width of [44, 52, 64]) {
        const rows = fitFeedbackMessage(RELEASE, { width, maxRows: 4 }).split('\n');

        expect(rows.length).toBeLessThanOrEqual(4);
        expect(rows.some((row) => row.includes('lockfile.json'))).toBe(true);
        for (const row of rows) expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(width);
      }
    });
  });

  it('shrinks a known message title only when the whole message passes its rows', () => {
    const message = { prefix: PREFIX, title: 'a b c d e f g h i j k l m n o p', suffix: SUFFIX };

    expect(fitFeedbackMessage(message, { width: 20, maxRows: 3 }).replace(/\n/g, ' ')).toBe(
      `${PREFIX}a b c d e f g h i j k l m n o p${SUFFIX}`,
    );
    const shrunk = fitFeedbackMessage(message, { width: 20, maxRows: 2 });
    expect(shrunk.split('\n')).toHaveLength(2);
    expect(shrunk.endsWith(SUFFIX)).toBe(true);
    expect(shrunk).toContain('…');
  });
});
