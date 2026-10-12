import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
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
    expect(fitFeedbackMessage('Cannot resume "alpha": missing state', 80)).toBe(
      'Cannot resume "alpha": missing state',
    );
  });

  it('leaves normal structured feedback unchanged when it fits', () => {
    expect(
      fitFeedbackMessage(
        {
          prefix: 'Cannot resume "',
          title: 'alpha',
          suffix: '": interrupted before it made progress — start it again.',
        },
        80,
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
      100,
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
      55,
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
      24,
    );

    expect(fitted.length).toBeLessThanOrEqual(24);
    expect(fitted).toContain('…');
  });

  describe.each(clusters)('with $name at the cut', ({ cluster, cells }) => {
    const source = `aaaaa${cluster}${'b'.repeat(10)}`;
    const keptWidth = 5 + cells + 1;

    it('keeps the cluster whole when it fits before the ellipsis', () => {
      const fitted = fitFeedbackMessage(source, keptWidth);

      expect(fitted).toBe(`aaaaa${cluster}…`);
      expectWholeGraphemeCut(source, fitted, keptWidth);
    });

    it('cuts before the whole cluster when it does not fit', () => {
      const fitted = fitFeedbackMessage(source, keptWidth - 1);

      expect(fitted).toBe('aaaaa…');
      expectWholeGraphemeCut(source, fitted, keptWidth - 1);
    });

    it('keeps the cluster whole in a title when it fits before the ellipsis', () => {
      const width = PREFIX.length + SUFFIX.length + keptWidth;
      const fitted = fitFeedbackMessage({ prefix: PREFIX, title: source, suffix: SUFFIX }, width);

      expect(fitted).toBe(`${PREFIX}aaaaa${cluster}…${SUFFIX}`);
      expectWholeGraphemeCut(source, titleHead(fitted), keptWidth);
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
    });

    it('cuts a title before the whole cluster when it does not fit', () => {
      const width = PREFIX.length + SUFFIX.length + keptWidth - 1;
      const fitted = fitFeedbackMessage({ prefix: PREFIX, title: source, suffix: SUFFIX }, width);

      expect(fitted).toBe(`${PREFIX}aaaaa…${SUFFIX}`);
      expectWholeGraphemeCut(source, titleHead(fitted), keptWidth - 1);
      expect(getTerminalCellWidth(fitted)).toBeLessThanOrEqual(width);
    });

    it('never splits the cluster at any width', () => {
      const repeated = `${cluster}${cluster}a${cluster}${'z'.repeat(12)}`;
      for (let width = 2; width <= 12; width++) {
        expectWholeGraphemeCut(repeated, fitFeedbackMessage(repeated, width), width);
        const titleWidth = PREFIX.length + SUFFIX.length + width;
        const fitted = fitFeedbackMessage(
          { prefix: PREFIX, title: repeated, suffix: SUFFIX },
          titleWidth,
        );
        expectWholeGraphemeCut(repeated, titleHead(fitted), width);
      }
    });
  });

  it('keeps tabs and escape sequences in the kept text', () => {
    const tabbed = `tab\there ${'x'.repeat(30)}`;
    const colored = `a\u001b[31mred\u001b[0m ${'x'.repeat(30)}`;

    expect(fitFeedbackMessage(tabbed, 12)).toBe('tab\ther…');
    expect(fitFeedbackMessage(colored, 12)).toBe('a\u001b[31mred\u001b[0m xxxxxx…');
  });

  it('cuts at the first line break, which never fits one row', () => {
    expect(fitFeedbackMessage('first\nsecond', 80)).toBe('first…');
    expect(fitFeedbackMessage(`${E_ACUTE}\nsecond`, 80)).toBe(`${E_ACUTE}…`);
  });
});
