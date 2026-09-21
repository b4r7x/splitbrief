import { describe, expect, it } from 'vitest';
import { reconcileFinalText } from './final-text.js';

describe('reconcileFinalText', () => {
  it('takes the final text whole when nothing streamed', () => {
    expect(reconcileFinalText('', 'doc')).toEqual({ kind: 'full', text: 'doc' });
  });

  it('keeps the streamed text when the final text restates it', () => {
    expect(reconcileFinalText('doc', 'doc')).toEqual({ kind: 'none' });
  });

  it('appends the part of the final text the stream has not carried', () => {
    expect(reconcileFinalText('do', 'doc')).toEqual({ kind: 'suffix', text: 'c' });
  });

  it('keeps the streamed text when the final text is only its last message', () => {
    expect(reconcileFinalText('## T001\nfirst\n## T002\nsecond', '## T002\nsecond')).toEqual({
      kind: 'none',
    });
  });

  it('replaces the streamed text when the final text differs', () => {
    expect(reconcileFinalText('draft', 'final')).toEqual({ kind: 'replace', text: 'final' });
  });
});
