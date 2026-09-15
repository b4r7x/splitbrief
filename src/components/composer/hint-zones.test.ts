import { describe, expect, it } from 'vitest';
import {
  compactComposerHints,
  computeComposerHintBudget,
  renderComposerHint,
} from './hint-zones.js';

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

  it('compacts the hint ladder: full → drop cost', () => {
    const hints = { keys: 'Ctrl+D detach', cost: '$0.03' };

    expect(compactComposerHints(hints, 20)).toEqual({ keys: 'Ctrl+D detach', cost: '$0.03' });
    expect(compactComposerHints(hints, 19)).toEqual({ keys: 'Ctrl+D detach', cost: undefined });
  });

  it('renders the right-aligned hint with the cost trailing the keys', () => {
    expect(renderComposerHint({ keys: 'Ctrl+D detach', cost: '$0.03' })).toBe(
      'Ctrl+D detach  $0.03',
    );
    expect(renderComposerHint({ keys: '', cost: '$0.03' })).toBe('$0.03');
    expect(renderComposerHint({ keys: 'Ctrl+D detach', cost: undefined })).toBe('Ctrl+D detach');
  });
});
