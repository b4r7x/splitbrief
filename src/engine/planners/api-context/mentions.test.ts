import { describe, it, expect } from 'vitest';
import { absolutePathsNamed } from './mentions.js';

describe('absolute paths named in a request', () => {
  it('removes punctuation, preserves spelling and order, and ignores relative paths and URLs', () => {
    const text = [
      'Read (/Users/x/notes/brief.md), then [`/tmp/notes/`].',
      `{"'/var/tmp/plan.md'"};`,
      '/Users/x/notes/brief.md /tmp/source.ts:42 /api/users.,;:!?)]}"\'`',
      'relative.md ./relative.md ~/notes.md https://example.com/file.md prefix/tmp/file',
    ].join('\n');

    expect(absolutePathsNamed(text)).toEqual([
      '/Users/x/notes/brief.md',
      '/tmp/notes/',
      '/var/tmp/plan.md',
      '/tmp/source.ts',
      '/api/users',
    ]);
  });

  it('keeps spaces in double-quoted, single-quoted and backticked paths', () => {
    expect(
      absolutePathsNamed(
        'Read "/Library/Application Support", \'/x/my notes.md\' and `/x/a b.md`.',
      ),
    ).toEqual(['/Library/Application Support', '/x/my notes.md', '/x/a b.md']);
  });

  it.each([
    ["don't read /a/b.md, it's fine", ['/a/b.md']],
    ['"read /a/b.md now"', ['/a/b.md']],
    ['it\'s in "/x/my notes.md", don\'t skip it', ['/x/my notes.md']],
    ["'/a/b.md'", ['/a/b.md']],
  ])('extracts paths without swallowing prose quotes in %s', (text, paths) => {
    expect(absolutePathsNamed(text)).toEqual(paths);
  });

  it.each(['', ' ', '(', '[', '{'])(
    'recognizes a quoted path after the opening boundary %j',
    (boundary) => {
      expect(absolutePathsNamed(`${boundary}"/x/my notes.md"`)).toEqual(['/x/my notes.md']);
    },
  );

  it.each(['', ' ', '.', ',', ';', ':', '!', '?', ')', ']', '}'])(
    'recognizes a quoted path before the closing boundary %j',
    (boundary) => {
      expect(absolutePathsNamed(`"/x/my notes.md"${boundary}`)).toEqual(['/x/my notes.md']);
    },
  );

  it.each([
    ["prefix'/hidden.md /bare.md'", ['/bare.md']],
    ["'/bare.md prose'word", ['/bare.md']],
  ])(
    'leaves a quote span without token boundaries available to the bare scan in %s',
    (text, paths) => {
      expect(absolutePathsNamed(text)).toEqual(paths);
    },
  );

  it('decodes backslash-escaped spaces from a Terminal drop', () => {
    expect(absolutePathsNamed('Read /Users/dev/My\\ Notes/brief.md.')).toEqual([
      '/Users/dev/My Notes/brief.md',
    ]);
  });

  it('strips line and column suffixes from quoted and bare paths', () => {
    expect(
      absolutePathsNamed('Read /existing/file.ts:42, "/x/my notes.md:7:3" and `/x/code.ts:8`.'),
    ).toEqual(['/existing/file.ts', '/x/my notes.md', '/x/code.ts']);
  });

  it('keeps first-mention order and de-duplicates across path spellings', () => {
    expect(
      absolutePathsNamed(
        '/first.md "/x/my notes.md" /middle.md `/first.md:42` /x/my\\ notes.md \'/last.md\'',
      ),
    ).toEqual(['/first.md', '/x/my notes.md', '/middle.md', '/last.md']);
  });

  it('does not extract unsupported file:// URIs, including quoted URIs with spaces', () => {
    expect(
      absolutePathsNamed('file:///x/a.md "file:///x/a b.md" `file:///x/c.md` /supported.md'),
    ).toEqual(['/supported.md']);
  });
});
