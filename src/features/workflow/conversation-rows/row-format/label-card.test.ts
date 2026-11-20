import { expect, it } from 'vitest';
import { cardRowsLayout } from './label-card.js';

it.each(['Blocking F1', 'Set aside V1'])(
  'aligns wrapped %s text with the first word of the finding',
  (label) => {
    const value = 'The report lists three missing files from the build.';
    const { wrapped } = cardRowsLayout({ label, value, width: 32 });
    const firstWord = wrapped[0]?.indexOf('The');
    expect(firstWord).toBeGreaterThan(0);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const continuation of wrapped.slice(1)) {
      expect(continuation.search(/\S/)).toBe(firstWord);
    }
  },
);
