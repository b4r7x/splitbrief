import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  createStreamedBlock,
  onlyAddsLineBreaks,
  reconcileFinalText,
} from './final-text.js';

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

describe('createStreamedBlock', () => {
  it('gives nothing when the record restates its deltas', () => {
    const block = createStreamedBlock();
    block.delta('Hel');
    block.delta('lo');
    expect(block.close('Hello')).toBe('');
  });

  it('gives the tail the deltas did not carry', () => {
    const block = createStreamedBlock();
    block.delta('Hel');
    expect(block.close('Hello')).toBe('lo');
  });

  it('keeps a record that differs from its deltas whole', () => {
    const block = createStreamedBlock();
    block.delta('Hel');
    block.delta('world.');
    expect(block.close('Hello world.')).toBe('Hello world.');
  });

  it('starts a new block after a record with no text', () => {
    const block = createStreamedBlock();
    block.delta('Done.');
    expect(block.close(undefined)).toBe('');
    expect(block.close('Done.')).toBe('Done.');
  });

  it('gives a record whole when no delta streamed', () => {
    expect(createStreamedBlock().close('A.')).toBe('A.');
  });
});

describe('appendMessage', () => {
  it('starts the message on its own line after a blank one', () => {
    expect(appendMessage('Reading a.ts.', 'VERDICT: brief')).toBe(
      'Reading a.ts.\n\nVERDICT: brief',
    );
    expect(appendMessage('Reading a.ts.\n', 'VERDICT: brief')).toBe(
      'Reading a.ts.\n\nVERDICT: brief',
    );
    expect(appendMessage('Reading a.ts.\n\n', 'VERDICT: brief')).toBe(
      'Reading a.ts.\n\nVERDICT: brief',
    );
  });

  it('adds nothing around an empty side', () => {
    expect(appendMessage('', 'only')).toBe('only');
    expect(appendMessage('only', '')).toBe('only');
  });
});

describe('onlyAddsLineBreaks', () => {
  it('accepts the streamed messages put on their own lines', () => {
    expect(
      onlyAddsLineBreaks('earlier Reading a.ts.VERDICT: brief', 'Reading a.ts.\n\nVERDICT: brief'),
    ).toBe(true);
  });

  it('rejects a final text that changes or adds anything but line breaks', () => {
    expect(
      onlyAddsLineBreaks('Reading a.ts.VERDICT: brief', 'Reading b.ts.\n\nVERDICT: brief'),
    ).toBe(false);
    expect(
      onlyAddsLineBreaks('Reading a.ts.VERDICT: brief', 'Reading a.ts.\n\nVERDICT: brief, b'),
    ).toBe(false);
    expect(onlyAddsLineBreaks('VERDICT: brief', 'Intro.\n\nVERDICT: brief')).toBe(false);
  });
});
