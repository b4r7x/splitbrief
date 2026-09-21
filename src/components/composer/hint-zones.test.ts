import { describe, expect, it } from 'vitest';
import { computeComposerHintBudget, fitComposerHintKeys } from './hint-zones.js';

describe('composer in-box hints', () => {
  it('budget shrinks linearly with box width', () => {
    expect(computeComposerHintBudget({ boxWidth: 80 })).toBe(48);
    expect(computeComposerHintBudget({ boxWidth: 45 })).toBe(13);
    expect(computeComposerHintBudget({ boxWidth: 40 })).toBe(8);
    expect(computeComposerHintBudget({ boxWidth: 10 })).toBe(0);
  });

  it('reclaims the padding cells for a flush (paddingX=0) box', () => {
    expect(computeComposerHintBudget({ boxWidth: 80, paddingX: 0 })).toBe(
      computeComposerHintBudget({ boxWidth: 80 }) + 2,
    );
  });

  it('reserves the chrome and the input floor, and no column beyond them', () => {
    // 2 border + 2 padding + 2 prompt + 2 margin + 24 input floor = 30 cells, and nothing else:
    // a money or token column would show up here as a wider reserve.
    expect(computeComposerHintBudget({ boxWidth: 100 })).toBe(100 - 32);
    expect(computeComposerHintBudget({ boxWidth: 100, paddingX: 0 })).toBe(100 - 30);
  });

  it('keeps the whole keys hint when it fits the budget', () => {
    expect(fitComposerHintKeys('Ctrl+D detach', 13)).toBe('Ctrl+D detach');
    expect(fitComposerHintKeys('', 0)).toBe('');
  });

  it('stands the keys hint down rather than squeezing the input', () => {
    expect(fitComposerHintKeys('Ctrl+D detach', 12)).toBe('');
  });
});
