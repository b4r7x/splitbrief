import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../display-text.js';
import { parseMarkdownBlocks } from './block-parser.js';
import { layoutMarkdown } from './layout.js';
import { layoutMarkdownTable } from './layout-table.js';
import type {
  MarkdownDocument,
  MarkdownLayoutLine,
  MarkdownTableAlignment,
  MarkdownTableBlock,
  MarkdownTableCell,
} from './types.js';

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
      '  # heading',
      '  ---',
      '  - item',
    ]);
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

  it('routes table blocks through the table layout', () => {
    const document: MarkdownDocument = {
      blocks: [tableBlock({ header: ['Name', 'Qty'], rows: [['apple', '1']] })],
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
      expect(segments.filter((segment) => segment.scope !== undefined)).not.toEqual([]);
      expect(
        segments
          .filter((segment) => segment.scope !== undefined)
          .every((segment) => segment.kind === 'code'),
      ).toBe(true);
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

const COLUMN_SEPARATOR_CHAR = '\u2502';

function tableCell(text: string): MarkdownTableCell {
  return { text, inlines: [{ kind: 'text', text }] };
}

function tableBlock(input: {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  alignments?: readonly MarkdownTableAlignment[];
}): MarkdownTableBlock {
  return {
    kind: 'table',
    alignments: input.alignments ?? input.header.map(() => 'left'),
    header: input.header.map(tableCell),
    rows: input.rows.map((row) => row.map(tableCell)),
  };
}

function tableLines(block: MarkdownTableBlock, width: number): string[] {
  return layoutMarkdownTable({ block, width, key: 'table' }).flatMap((row) =>
    row.lines.map(lineText),
  );
}

describe('layoutMarkdownTable', () => {
  it('aligns columns, separates them with borders, and underlines the header', () => {
    const block = tableBlock({
      header: ['Name', 'Qty'],
      rows: [
        ['apple', '1'],
        ['kiwi', '12'],
      ],
    });

    expect(tableLines(block, 40)).toEqual([
      'Name  │ Qty',
      '\u2500'.repeat(11),
      'apple │ 1',
      'kiwi  │ 12',
    ]);
  });

  it('pads cells according to column alignment', () => {
    const block = tableBlock({
      header: ['left', 'center', 'right'],
      rows: [['a', 'b', 'c']],
      alignments: ['left', 'center', 'right'],
    });

    expect(tableLines(block, 40)).toEqual([
      'left │ center │ right',
      '\u2500'.repeat(21),
      'a    │   b    │     c',
    ]);
  });

  it('marks header cells, separators, padding, and the underline with table segment kinds', () => {
    const rows = layoutMarkdownTable({
      block: tableBlock({ header: ['Name', 'Qty'], rows: [['apple', '1']] }),
      width: 40,
      key: 'k',
    });

    const headerSegments = rows[0]?.lines[0]?.segments ?? [];
    expect(headerSegments.map((segment) => segment.kind)).toEqual([
      'tableHeader',
      'tableBorder',
      'tableHeader',
    ]);

    const underlineSegments = rows[0]?.lines[1]?.segments ?? [];
    expect(underlineSegments.every((segment) => segment.kind === 'tableBorder')).toBe(true);

    const bodySegments = rows[1]?.lines[0]?.segments ?? [];
    expect(bodySegments.some((segment) => segment.kind === 'text')).toBe(true);
    expect(bodySegments.some((segment) => segment.kind === 'tableBorder')).toBe(true);
  });

  it('wraps overflowing cells inside their column without corrupting neighbors', () => {
    const path = 'src/features/workflow/conversation-rows/markdown-rows.ts';
    const block = tableBlock({ header: ['File', 'Note'], rows: [[path, 'ok']] });
    const width = 24;
    const rows = layoutMarkdownTable({ block, width, key: 'k' });
    const lines = rows.flatMap((row) => row.lines.map(lineText));

    expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);

    const bodyLines = (rows[1]?.lines ?? []).map(lineText);
    expect(bodyLines.length).toBeGreaterThan(1);
    expect(bodyLines[0]).toContain('ok');
    expect(
      bodyLines.map((line) => (line.split(COLUMN_SEPARATOR_CHAR)[0] ?? '').trim()).join(''),
    ).toBe(path);
  });

  it.each([8, 12, 16, 20, 28])('keeps every emitted line within width %d', (width) => {
    const block = tableBlock({
      header: ['Alpha column', 'Beta', 'Gamma column'],
      rows: [
        ['long content here that wraps', 'x', 'more long content'],
        ['a', 'medium text', 'b'],
      ],
    });
    const lines = tableLines(block, width);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);
  });

  it('keeps link segments and hrefs inside body cells', () => {
    const block: MarkdownTableBlock = {
      kind: 'table',
      alignments: ['left'],
      header: [tableCell('Docs')],
      rows: [
        [
          {
            text: '[docs](https://example.com)',
            inlines: [{ kind: 'link', text: 'docs', href: 'https://example.com' }],
          },
        ],
      ],
    };
    const rows = layoutMarkdownTable({ block, width: 40, key: 'k' });

    const link = (rows[1]?.lines[0]?.segments ?? []).find((segment) => segment.kind === 'link');
    expect(link?.text).toBe('docs');
    expect(link?.href).toBe('https://example.com');
  });
});
