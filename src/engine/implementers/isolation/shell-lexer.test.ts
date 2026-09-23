import { describe, expect, it } from 'vitest';
import { HOME_MARK, lexShell, OPAQUE } from './shell-lexer.js';

describe('lexShell', () => {
  it('resolves quotes and escapes into words', () => {
    expect(lexShell(`cat "a b" 'c d' e\\ f "g\\"h"`).commands).toEqual([
      { words: ['cat', 'a b', 'c d', 'e f', 'g"h'], redirects: [] },
    ]);
  });

  it('marks the home that `~` and `$HOME` name, and a `~` only where a word starts', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the command must carry a literal shell ${HOME}
    expect(lexShell('ls ~ ~/x $HOME/y ${HOME} a~ "~"').commands[0]?.words).toEqual([
      'ls',
      HOME_MARK,
      `${HOME_MARK}/x`,
      `${HOME_MARK}/y`,
      HOME_MARK,
      'a~',
      '~',
    ]);
  });

  it('separates redirections from arguments and drops a descriptor duplication', () => {
    expect(lexShell('cat < in.txt > out.txt 2>/dev/null 2>&1 >> log').commands).toEqual([
      {
        words: ['cat'],
        redirects: [
          { access: 'read', target: 'in.txt' },
          { access: 'write', target: 'out.txt' },
          { access: 'write', target: '/dev/null' },
          { access: 'write', target: 'log' },
        ],
      },
    ]);
  });

  it('lifts substitutions out as nested scripts and leaves an opaque mark in the word', () => {
    expect(lexShell('i=$((i+1)); cat $(find /x) `pwd` <(ls y)')).toEqual({
      commands: [
        { words: [`i=${OPAQUE}`], redirects: [] },
        { words: ['cat', OPAQUE, OPAQUE, OPAQUE], redirects: [] },
      ],
      nested: ['find /x', 'pwd', 'ls y'],
    });
  });

  it('skips a here-document body and reads the command after it', () => {
    expect(lexShell("cat > x <<'EOF'\n/secret\nEOF\nls y").commands).toEqual([
      { words: ['cat'], redirects: [{ access: 'write', target: 'x' }] },
      { words: ['ls', 'y'], redirects: [] },
    ]);
  });
});
