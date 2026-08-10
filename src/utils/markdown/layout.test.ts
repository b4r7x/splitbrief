import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../display-text.js';
import { parseMarkdownBlocks } from './block-parser.js';
import { layoutMarkdown } from './layout.js';
import type { MarkdownDocument, MarkdownLayoutLine } from './types.js';

const THEMATIC_BREAK_CHAR = '\u2500';

function lineText(line: MarkdownLayoutLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

function layoutLines(source: string, width: number): string[] {
  const layout = layoutMarkdown(parseMarkdownBlocks(source), { width });
  return layout.rows.flatMap((row) => row.lines.map(lineText));
}

describe('layoutMarkdown', () => {
  it('uses terminal width for thematic breaks', () => {
    expect(layoutLines('---', 12)).toEqual([THEMATIC_BREAK_CHAR.repeat(12)]);
    expect(layoutLines('---', 28)).toEqual([THEMATIC_BREAK_CHAR.repeat(28)]);
  });

  it('produces more rows at narrow widths and keeps long paths inside row width', () => {
    const source =
      'This paragraph references src/utils/markdown/really-long-path-for-layout-tests.ts and keeps wrapping.';

    const narrow = layoutMarkdown(parseMarkdownBlocks(source), { width: 24 });
    const wide = layoutMarkdown(parseMarkdownBlocks(source), { width: 80 });
    const narrowLines = narrow.rows.flatMap((row) => row.lines.map(lineText));

    expect(narrow.height).toBeGreaterThan(wide.height);
    expect(narrowLines.every((line) => getTerminalCellWidth(line) <= 24)).toBe(true);
    expect(layoutLines(source, 80)).toEqual([
      'This paragraph references',
      'src/utils/markdown/really-long-path-for-layout-tests.ts and keeps wrapping.',
    ]);
  });

  it('does not interpret markdown syntax inside code fences', () => {
    const layout = layoutMarkdown(
      parseMarkdownBlocks(['```', '# heading', '---', '- item', '```'].join('\n')),
      { width: 40 },
    );

    expect(layout.rows.map((row) => row.blockKind)).toEqual(['code']);
    expect(layout.rows.flatMap((row) => row.lines.map(lineText))).toEqual([
      '▏',
      '▏ # heading',
      '▏ ---',
      '▏ - item',
      '▏',
    ]);
  });

  it('pads a code block with a bare-rail line above and below its content', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks(['```', 'const a = 1;', '```'].join('\n')), {
      width: 40,
    });
    const row = layout.rows[0];
    const padSegments = [{ kind: 'codeGutter', text: '▏' }];

    expect(row?.lines.map(lineText)).toEqual(['▏', '▏ const a = 1;', '▏']);
    expect(row?.lines.at(0)?.segments).toEqual(padSegments);
    expect(row?.lines.at(-1)?.segments).toEqual(padSegments);
    expect(row?.height).toBe(3);
    expect(layout.height).toBe(3);
  });

  it('pads a highlighted code block the same way as the literal path', () => {
    const source = ['```ts', 'const a = 1;', '```'].join('\n');
    const row = layoutMarkdown(parseMarkdownBlocks(source), { width: 40 }).rows[0];

    expect(row?.lines.map(lineText)).toEqual(['▏', '▏ const a = 1;', '▏']);
    expect(row?.lines.at(0)?.segments).toEqual([{ kind: 'codeGutter', text: '▏' }]);
    expect(row?.lines.at(-1)?.segments).toEqual([{ kind: 'codeGutter', text: '▏' }]);
  });

  it('repeats the code gutter on wrapped continuation lines', () => {
    const source = ['```', `const value = '${'x'.repeat(40)}';`, '```'].join('\n');
    const lines = layoutMarkdown(parseMarkdownBlocks(source), { width: 24 }).rows.flatMap(
      (row) => row.lines,
    );
    const texts = lines.map(lineText);

    expect(texts.slice(1, -1).length).toBeGreaterThan(1);
    expect(lines.every((line) => line.segments[0]?.kind === 'codeGutter')).toBe(true);
    expect(texts.slice(1, -1).every((text) => text.startsWith('▏ '))).toBe(true);
    expect(texts.at(0)).toBe('▏');
    expect(texts.at(-1)).toBe('▏');
  });

  it('leaves frontmatter metadata free of the code gutter', () => {
    const source = ['---', 'title: Doc', '---', '', 'body'].join('\n');
    const segments = layoutMarkdown(parseMarkdownBlocks(source), { width: 40 }).rows.flatMap(
      (row) => row.lines.flatMap((line) => line.segments),
    );

    expect(segments.some((segment) => segment.kind === 'metadata')).toBe(true);
    expect(segments.some((segment) => segment.kind === 'codeGutter')).toBe(false);
  });

  it('wraps wide and combining grapheme clusters by terminal cells', () => {
    const developerEmoji = '👩‍💻';

    expect(layoutLines('界'.repeat(6), 8)).toEqual(['界'.repeat(4), '界'.repeat(2)]);
    expect(layoutLines('e\u0301'.repeat(10), 9)).toEqual(['e\u0301'.repeat(9), 'e\u0301']);
    expect(layoutLines(developerEmoji.repeat(5), 8)).toEqual([
      developerEmoji.repeat(4),
      developerEmoji,
    ]);
  });

  it('keeps wide-character markdown lines within terminal cell width', () => {
    const source = 'src/界語/emoji-👩‍💻/cafe\u0301-file.ts'.repeat(2);
    const lines = layoutLines(source, 12);

    expect(lines.every((line) => getTerminalCellWidth(line) <= 12)).toBe(true);
    expect(lines.join('')).toBe(source);
  });

  it('lays out deeply nested quote markers without exhausting the call stack', () => {
    const quoted = `${Array.from({ length: 5000 }, () => '>').join(' ')} quoted`;

    expect(() => layoutMarkdown(parseMarkdownBlocks(quoted), { width: 40 })).not.toThrow();
  });

  it('keeps adjacent links unmerged', () => {
    const document: MarkdownDocument = {
      blocks: [
        {
          kind: 'paragraph',
          text: 'firstsecond',
          inlines: [
            { kind: 'link', text: 'first', href: 'https://a.example' },
            { kind: 'link', text: 'second', href: 'https://b.example' },
          ],
        },
      ],
    };

    const layout = layoutMarkdown(document, { width: 40 });
    const links = layout.rows
      .flatMap((row) => row.lines.flatMap((line) => line.segments))
      .filter((segment) => segment.kind === 'link');

    expect(links.map((segment) => segment.text)).toEqual(['first', 'second']);
    expect(links.map((segment) => segment.href)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('lays out htmlComment blocks as zero rows', () => {
    const document: MarkdownDocument = {
      blocks: [{ kind: 'htmlComment', lines: ['<!-- Q:{"id":"q1"} -->'] }],
    };

    const layout = layoutMarkdown(document, { width: 40 });

    expect(layout.rows).toEqual([]);
    expect(layout.height).toBe(0);
  });

  it('keeps text after an inline-closed comment visible while hiding the comment', () => {
    const lines = layoutLines('<!-- note --> visible text after the comment', 80);

    expect(lines.join(' ')).toContain('visible text after the comment');
    expect(lines.join(' ')).not.toContain('note');
  });

  it('keeps prose after a question marker comment visible', () => {
    const lines = layoutLines('<!-- Q:{"id":"q1"} --> Next, run the tests.', 80);

    expect(lines.join(' ')).toContain('Next, run the tests.');
    expect(lines.join(' ')).not.toContain('q1');
  });

  it('carries heading depth on heading segments', () => {
    const document: MarkdownDocument = {
      blocks: [
        { kind: 'heading', depth: 5, text: 'Deep', inlines: [{ kind: 'text', text: 'Deep' }] },
      ],
    };

    const heading = layoutMarkdown(document, { width: 40 })
      .rows.flatMap((row) => row.lines.flatMap((line) => line.segments))
      .find((segment) => segment.kind === 'heading');

    expect(heading?.depth).toBe(5);
  });

  it('opens a mid-document heading with one blank line', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro text\n\n## Section'), { width: 40 });
    const heading = layout.rows[1];

    expect(heading?.blockKind).toBe('heading');
    expect(heading?.lines.map(lineText)).toEqual(['', 'Section']);
    expect(heading?.height).toBe(2);
    expect(layout.height).toBe(3);
  });

  it('keeps a document-leading heading flush with the top', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('# Title\n\nbody'), { width: 40 });

    expect(layout.rows[0]?.lines.map(lineText)).toEqual(['Title']);
    expect(layout.rows[0]?.height).toBe(1);
    expect(layout.height).toBe(2);
  });

  it('opens a leading heading with a blank line when leadingHeadingGap is set', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('# Title'), {
      width: 40,
      leadingHeadingGap: true,
    });

    expect(layout.rows[0]?.lines.map(lineText)).toEqual(['', 'Title']);
    expect(layout.rows[0]?.height).toBe(2);
    expect(layout.height).toBe(2);
  });

  it('counts the gap once for a heading that wraps across lines', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro\n\n## Section title that wraps'), {
      width: 12,
    });
    const heading = layout.rows[1];

    expect(heading?.lines.map(lineText)).toEqual(['', 'Section', 'title that', 'wraps']);
    expect(heading?.height).toBe(4);
  });

  it('opens a heading that starts a blockquote with one blank line', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro\n\n> # Quoted\n> body'), {
      width: 40,
    });
    const quotedHeading = layout.rows[1];

    expect(quotedHeading?.blockKind).toBe('blockquote');
    expect(quotedHeading?.lines.map(lineText)).toEqual(['▎ ', '▎ Quoted']);
    expect(quotedHeading?.height).toBe(2);
  });

  it('maps strikethrough inline tokens onto strikethrough segments', () => {
    const document: MarkdownDocument = {
      blocks: [
        {
          kind: 'paragraph',
          text: 'gone',
          inlines: [{ kind: 'strikethrough', text: 'gone' }],
        },
      ],
    };

    const segments = layoutMarkdown(document, { width: 40 }).rows.flatMap((row) =>
      row.lines.flatMap((line) => line.segments),
    );

    expect(segments).toEqual([{ kind: 'strikethrough', text: 'gone' }]);
  });

  it('gives nested unordered items a hollow bullet and leaves ordered markers alone', () => {
    expect(layoutLines('- top\n  - nested', 40)).toEqual(['• top', '  ◦ nested']);
    expect(layoutLines('1. top\n  1. nested', 40)).toEqual(['1. top', '  1. nested']);
  });

  it('routes table blocks through the table layout', () => {
    const document: MarkdownDocument = {
      blocks: [
        {
          kind: 'table',
          alignments: ['left', 'left'],
          header: [
            { text: 'Name', inlines: [{ kind: 'text', text: 'Name' }] },
            { text: 'Qty', inlines: [{ kind: 'text', text: 'Qty' }] },
          ],
          rows: [
            [
              { text: 'apple', inlines: [{ kind: 'text', text: 'apple' }] },
              { text: '1', inlines: [{ kind: 'text', text: '1' }] },
            ],
          ],
        },
      ],
    };

    const layout = layoutMarkdown(document, { width: 40 });

    expect(layout.rows.length).toBeGreaterThan(0);
    expect(layout.rows.every((row) => row.blockKind === 'table')).toBe(true);
  });

  describe('highlighted code layout', () => {
    function fenceLayout(language: string, lines: readonly string[], width: number) {
      const source = [`\`\`\`${language}`, ...lines, '```'].join('\n');
      return layoutMarkdown(parseMarkdownBlocks(source), { width });
    }

    function fenceSegments(language: string, lines: readonly string[], width: number) {
      return fenceLayout(language, lines, width).rows.flatMap((row) =>
        row.lines.flatMap((line) => line.segments),
      );
    }

    it('renders a ts fence with at least two distinct highlight scopes', () => {
      const segments = fenceSegments('ts', ["const greeting = 'hello';"], 60);
      const scopes = new Set(
        segments.map((segment) => segment.scope).filter((scope) => scope !== undefined),
      );

      expect(scopes.size).toBeGreaterThanOrEqual(2);
      expect(
        segments
          .filter((segment) => segment.scope !== undefined)
          .every((segment) => segment.kind === 'code'),
      ).toBe(true);
    });

    it('opens a highlighted fence line with the same code gutter as the literal path', () => {
      const segments = fenceSegments('ts', ["const greeting = 'hello';"], 60);

      expect(segments[0]).toEqual({ kind: 'codeGutter', text: '▏' });
      expect(segments[1]).toEqual({ kind: 'codeGutter', text: '▏ ' });
    });

    it('keeps an unknown language monochrome with scope-less code segments', () => {
      const segments = fenceSegments('notalanguage', ["const greeting = 'hello';"], 60);

      expect(segments.every((segment) => segment.scope === undefined)).toBe(true);
      expect(segments.some((segment) => segment.kind === 'code')).toBe(true);
    });

    it('preserves the scope on continuation lines when a highlighted line wraps', () => {
      const literal = `'${'a'.repeat(40)}'`;
      const layout = fenceLayout('ts', [`const s = ${literal};`], 24);
      const lines = layout.rows.flatMap((row) => row.lines);

      expect(lines.length).toBeGreaterThan(1);
      const continuationScopes = lines
        .slice(1)
        .flatMap((line) => line.segments)
        .map((segment) => segment.scope);
      expect(continuationScopes).toContain('string');
    });

    it.each([
      16, 24, 40, 60, 80,
    ])('keeps line counts and text identical to the monochrome path at width %d', (width) => {
      const lines = ['const value = 42;', '', '// done'];
      const highlighted = fenceLayout('ts', lines, width);
      const monochrome = fenceLayout('notalanguage', lines, width);
      const lineTexts = (layout: ReturnType<typeof layoutMarkdown>) =>
        layout.rows.flatMap((row) => row.lines.map(lineText));

      expect(highlighted.height).toBe(monochrome.height);
      expect(lineTexts(highlighted)).toEqual(lineTexts(monochrome));
    });
  });
});
