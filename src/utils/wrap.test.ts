import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from './display-text.js';
import { wrapHard, wrapPathAware } from './wrap.js';

describe('wrapPathAware', () => {
  it('breaks an over-long path after a separator instead of mid-filename', () => {
    const path = '.splitbrief/sessions/2026-08-10-a/state.json';

    expect(wrapHard(path, 36).split('\n')).toEqual([
      '.splitbrief/sessions/2026-08-10-a/st',
      'ate.json',
    ]);
    expect(wrapPathAware(path, 36).split('\n')).toEqual([
      '.splitbrief/sessions/2026-08-10-a/',
      'state.json',
    ]);
  });

  it('leaves text that already fits exactly as it was', () => {
    expect(wrapPathAware('write src/a.ts', 36)).toBe('write src/a.ts');
    expect(wrapPathAware('', 36)).toBe('');
  });

  it('keeps wrapping on spaces first and only splits the word that overflows', () => {
    expect(wrapPathAware('write .splitbrief/sessions/state.json now', 20).split('\n')).toEqual([
      'write',
      '.splitbrief/',
      'sessions/state.json',
      'now',
    ]);
  });

  it('falls back to a character break when one segment is wider than the row', () => {
    expect(wrapPathAware('aaaaaaaa/bb', 4).split('\n')).toEqual(['aaaa', 'aaaa', '/bb']);
  });

  it('preserves existing line breaks, so one disclosed fact stays one line', () => {
    expect(wrapPathAware('Executable: "/bin/sh"\nNetwork: open', 40).split('\n')).toEqual([
      'Executable: "/bin/sh"',
      'Network: open',
    ]);
  });

  it('wraps CJK paths by terminal cells', () => {
    const lines = wrapPathAware('界界界', 4).split('\n');

    expect(lines).toEqual(['界界', '界']);
    expect(lines.every((line) => getTerminalCellWidth(line) <= 4)).toBe(true);
  });

  it('keeps a ZWJ emoji grapheme intact while wrapping', () => {
    const lines = wrapPathAware('👩‍💻👩‍💻', 3).split('\n');

    expect(lines).toEqual(['👩‍💻', '👩‍💻']);
    expect(lines.join('')).toBe('👩‍💻👩‍💻');
  });

  it('falls back to whole graphemes for an over-wide path segment', () => {
    const lines = wrapPathAware('界界/ok', 3).split('\n');

    expect(lines).toEqual(['界', '界/', 'ok']);
    expect(lines.join('')).toBe('界界/ok');
  });
});
