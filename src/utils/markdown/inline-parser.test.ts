import { describe, expect, it } from 'vitest';
import { parseMarkdownInlines } from './inline-parser.js';

describe('parseMarkdownInlines', () => {
  it('gives inline code precedence over emphasis', () => {
    const tokens = parseMarkdownInlines('Use `**literal**` before **bold** and *italic*');

    expect(tokens).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: '**literal**' },
      { kind: 'text', text: ' before ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'italic' },
    ]);
  });

  it('leaves paths and uppercase words as plain markdown text', () => {
    const tokens = parseMarkdownInlines('Read src/utils/markdown/layout.ts before RELEASE NOTES');

    expect(tokens).toEqual([
      {
        kind: 'text',
        text: 'Read src/utils/markdown/layout.ts before RELEASE NOTES',
      },
    ]);
  });

  it('supports bold italic spans when the delimiter is unambiguous', () => {
    expect(parseMarkdownInlines('Ship ***carefully***')).toEqual([
      { kind: 'text', text: 'Ship ' },
      { kind: 'boldItalic', text: 'carefully' },
    ]);
  });

  describe('links', () => {
    it.each([
      ['[docs](https://example.com)', 'docs', 'https://example.com'],
      ['see [guide](./docs/guide.md) now', 'guide', './docs/guide.md'],
      ['[src](src/utils/error.ts:12)', 'src', 'src/utils/error.ts:12'],
      ['[spaced]( https://a.dev )', 'spaced', 'https://a.dev'],
      ['tail [last](x)', 'last', 'x'],
    ])('parses a link token from %s', (source, label, href) => {
      expect(parseMarkdownInlines(source)).toContainEqual({ kind: 'link', text: label, href });
    });

    it.each([
      [
        '[x](https://en.wikipedia.org/wiki/Foo_(bar))',
        'x',
        'https://en.wikipedia.org/wiki/Foo_(bar)',
      ],
      ['[y](http://a/b_(c_(d)))', 'y', 'http://a/b_(c_(d))'],
    ])('balances parentheses in the link target of %s', (source, label, href) => {
      expect(parseMarkdownInlines(source)).toEqual([{ kind: 'link', text: label, href }]);
    });

    it('never leaks the ]( sequence or the target into token text', () => {
      const sources = [
        '[docs](https://example.com)',
        'before [a](b) after',
        '[one](1) and [two](2)',
      ];

      for (const source of sources) {
        const tokens = parseMarkdownInlines(source);
        for (const token of tokens) {
          expect(token.text).not.toContain('](');
        }
        expect(
          tokens.filter((token) => token.kind !== 'link').map((token) => token.text),
        ).not.toContain('https://example.com');
      }
    });

    it('keeps the label as plain text without nested emphasis', () => {
      expect(parseMarkdownInlines('[**bold** label](x)')).toEqual([
        { kind: 'link', text: '**bold** label', href: 'x' },
      ]);
    });

    it('degrades images to their alt text', () => {
      expect(parseMarkdownInlines('see ![diagram](img.png) here')).toEqual([
        { kind: 'text', text: 'see ' },
        { kind: 'text', text: 'diagram' },
        { kind: 'text', text: ' here' },
      ]);
    });

    it.each([
      ['[a] (b)', '[a] (b)'],
      ['[a](b', '[a](b'],
      ['[a] b', '[a] b'],
      ['plain [brackets] only', 'plain [brackets] only'],
      ['(target) without label', '(target) without label'],
    ])('keeps %s as plain text', (source, text) => {
      expect(parseMarkdownInlines(source)).toEqual([{ kind: 'text', text }]);
    });

    it('restarts the scan at a nested opening bracket', () => {
      expect(parseMarkdownInlines('[skip [real](x)')).toEqual([
        { kind: 'text', text: '[skip ' },
        { kind: 'link', text: 'real', href: 'x' },
      ]);
    });

    it('keeps a code span containing link syntax as code', () => {
      expect(parseMarkdownInlines('`[x](y)`')).toEqual([{ kind: 'code', text: '[x](y)' }]);
    });

    it.each([
      [
        '[`markdown.tsx`](src/components/markdown.tsx)',
        '`markdown.tsx`',
        'src/components/markdown.tsx',
      ],
      ['See [`file.ts`](src/file.ts) now', '`file.ts`', 'src/file.ts'],
    ])('lets a link spanning a code span win from %s', (source, label, href) => {
      const tokens = parseMarkdownInlines(source);

      expect(tokens).toContainEqual({ kind: 'link', text: label, href });
      for (const token of tokens) {
        expect(token.text).not.toContain('](');
      }
    });
  });

  describe('strikethrough', () => {
    it.each([
      ['~~gone~~', 'gone'],
      ['keep ~~old~~ new', 'old'],
      ['lead ~~a b~~', 'a b'],
      ['mixed **bold** ~~struck~~', 'struck'],
    ])('parses a strikethrough token from %s', (source, text) => {
      expect(parseMarkdownInlines(source)).toContainEqual({ kind: 'strikethrough', text });
    });

    it('parses every span in a multi-strikethrough line', () => {
      expect(parseMarkdownInlines('~~1~~ and ~~2~~')).toEqual([
        { kind: 'strikethrough', text: '1' },
        { kind: 'text', text: ' and ' },
        { kind: 'strikethrough', text: '2' },
      ]);
    });

    it('keeps unterminated tildes literal', () => {
      expect(parseMarkdownInlines('~~open forever')).toEqual([
        { kind: 'text', text: '~~open forever' },
      ]);
    });

    it('never leaks tilde delimiters into token text', () => {
      const tokens = parseMarkdownInlines('a ~~b~~ c ~~d~~ e');

      for (const token of tokens) {
        expect(token.text).not.toContain('~~');
      }
    });
  });

  describe('inline html comments', () => {
    it.each([
      ['before <!-- note --> after', 'before  after'],
      ['<!-- note -->', ''],
      ['a <!-- one --> b <!-- two --> c', 'a  b  c'],
      ['text <!-- Q:{"id":"q1"} --> tail', 'text  tail'],
      ['<!-- [x](y) **bold** -->', ''],
    ])('strips comments from %s', (source, visible) => {
      const rendered = parseMarkdownInlines(source)
        .map((token) => token.text)
        .join('');

      expect(rendered).toBe(visible);
    });

    it('keeps the text surrounding a comment', () => {
      expect(parseMarkdownInlines('keep <!-- gone --> rest')).toEqual([
        { kind: 'text', text: 'keep ' },
        { kind: 'text', text: ' rest' },
      ]);
    });

    it('emits nothing for a comment-only input', () => {
      expect(parseMarkdownInlines('<!-- only -->')).toEqual([]);
    });

    it('hides an unterminated comment to the end of the text', () => {
      expect(parseMarkdownInlines('visible <!-- Q:{"id":"q1","question":"partial')).toEqual([
        { kind: 'text', text: 'visible ' },
      ]);
    });

    it('hides content after an unterminated comment even across backticks', () => {
      const tokens = parseMarkdownInlines('intro <!-- Q:{"question":"use `a` or `b`?');

      expect(tokens).toEqual([{ kind: 'text', text: 'intro ' }]);
    });

    it('keeps a code span containing a comment as code', () => {
      expect(parseMarkdownInlines('`<!-- x -->`')).toEqual([{ kind: 'code', text: '<!-- x -->' }]);
    });

    it('still parses code spans between comments', () => {
      expect(parseMarkdownInlines('<!-- a --> `code` <!-- b -->')).toEqual([
        { kind: 'text', text: ' ' },
        { kind: 'code', text: 'code' },
        { kind: 'text', text: ' ' },
      ]);
    });
  });
});
