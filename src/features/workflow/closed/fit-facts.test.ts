import { describe, expect, it } from 'vitest';
import { cutFactMiddle, fitFacts } from './fit-facts.js';

const fact = (text: string) => [{ text, tone: 'textDim' as const }];
const textOf = (spans: readonly { text: string }[]) => spans.map((span) => span.text).join('');

const build = [
  fact('15/15 briefs passed'),
  fact('8 from fix cycles'),
  fact('2 consulted'),
  fact('3h 55m 12s'),
];

describe('fitFacts', () => {
  it('joins every fact when the budget seats them all', () => {
    expect(textOf(fitFacts(build, 66))).toBe(
      '15/15 briefs passed · 8 from fix cycles · 2 consulted · 3h 55m 12s',
    );
  });

  it('sheds the facts between the first and the last from the right, so the time stays', () => {
    expect(textOf(fitFacts(build, 65))).toBe(
      '15/15 briefs passed · 8 from fix cycles · 3h 55m 12s',
    );
    expect(textOf(fitFacts(build, 51))).toBe('15/15 briefs passed · 3h 55m 12s');
  });

  it('sheds the last fact when it cannot stand beside the first', () => {
    expect(textOf(fitFacts(build, 31))).toBe('15/15 briefs passed');
  });

  it('keeps no fact when the first one does not fit whole', () => {
    expect(fitFacts(build, 18)).toEqual([]);
    expect(fitFacts([], 80)).toEqual([]);
  });

  it('keeps the spans of a fact and dims the separator', () => {
    expect(
      fitFacts(
        [
          [
            { text: 'review ', tone: 'textDim' },
            { text: 'failed', tone: 'error' },
          ],
          fact('1 note'),
        ],
        80,
      ),
    ).toEqual([
      { text: 'review ', tone: 'textDim' },
      { text: 'failed', tone: 'error' },
      { text: ' · ', tone: 'textDim' },
      { text: '1 note', tone: 'textDim' },
    ]);
  });
});

describe('cutFactMiddle', () => {
  it('keeps both ends of a fact and the tone of each end', () => {
    const cut = cutFactMiddle(
      [
        { text: 'src/features/summary/components/very-long-file-name-here.tsx', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'partial', tone: 'warning' },
      ],
      27,
    );

    expect(textOf(cut)).toBe('src/features/…tsx · partial');
    expect(cut.at(-1)).toEqual({ text: 'partial', tone: 'warning' });
    expect(cut[0]?.tone).toBe('textDim');
  });
});
