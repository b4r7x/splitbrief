import { describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getTerminalCellWidth } from '../display-text.js';
import { glyph, markdownLayoutGlyphs } from '../../lib/glyphs.js';
import { parseMarkdownBlocks } from './block-parser.js';
import { layoutMarkdown } from './layout.js';
import type { MarkdownDocument, MarkdownLayoutLine } from './types.js';

// These expectations spell the unicode tier out literally, so the tier is pinned here rather
// than left to whether the process running the suite happens to own a TTY.
forceUnicodeGlyphs();

const GLYPHS = markdownLayoutGlyphs();
const RULE = glyph('divider');
const RAIL = glyph('codeRail');

function lineText(line: MarkdownLayoutLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

function layoutLines(source: string, width: number): string[] {
  const layout = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width });
  return layout.rows.flatMap((row) => row.lines.map(lineText));
}

describe('layoutMarkdown', () => {
  it('uses terminal width for thematic breaks', () => {
    expect(layoutLines('---', 12)).toEqual([RULE.repeat(12)]);
    expect(layoutLines('---', 28)).toEqual([RULE.repeat(28)]);
  });

  it('produces more rows at narrow widths and keeps long paths inside row width', () => {
    const source =
      'This paragraph references src/utils/markdown/really-long-path-for-layout-tests.ts and keeps wrapping.';

    const narrow = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 24 });
    const wide = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 80 });
    const narrowLines = narrow.rows.flatMap((row) => row.lines.map(lineText));

    expect(narrow.height).toBeGreaterThan(wide.height);
    expect(narrowLines.every((line) => getTerminalCellWidth(line) <= 24)).toBe(true);
    expect(layoutLines(source, 80)).toEqual([
      'This paragraph references',
      'src/utils/markdown/really-long-path-for-layout-tests.ts and keeps wrapping.',
    ]);
  });

  // The session header a generator stamps on a file says nothing a reader wants, and it would
  // take the most valuable rows on the surface. Task Brief metadata is content and still renders.
  it('renders no row for a document frontmatter header', () => {
    const source = ['---', 'title: Doc', 'owner: docs', '---', '', 'body'].join('\n');
    const layout = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 });

    expect(layout.rows.map((row) => row.blockKind)).toEqual(['paragraph']);
    expect(layout.rows.flatMap((row) => row.lines.map(lineText))).toEqual(['body']);
  });

  it('leaves task brief metadata visible and free of the code gutter', () => {
    const source = [
      '---',
      'id: T001',
      'title: Doc',
      'action: modify',
      'file: src/a.ts',
      'depends_on: []',
      '---',
      '',
      'body',
    ].join('\n');
    const segments = layoutMarkdown(parseMarkdownBlocks(source), {
      glyphs: GLYPHS,
      width: 40,
    }).rows.flatMap((row) => row.lines.flatMap((line) => line.segments));

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

  it.each([8, 12, 16])('keeps nested quote/list rows within width %d', (width) => {
    const source = `${Array.from({ length: width }, () => '>').join(' ')} - 界 👩‍💻 nested text`;
    const layout = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width });
    const lines = layout.rows.flatMap((row) => row.lines.map(lineText));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => getTerminalCellWidth(line) <= layout.width)).toBe(true);
    expect(lines.join('')).toContain('界');
    expect(lines.join('')).toContain('👩‍💻');
  });

  it('lays out deeply nested quote markers without exhausting the call stack', () => {
    const quoted = `${Array.from({ length: 5000 }, () => '>').join(' ')} quoted`;

    const layout = layoutMarkdown(parseMarkdownBlocks(quoted), { glyphs: GLYPHS, width: 40 });

    expect(layout.height).toBeGreaterThan(0);
    expect(layout.rows.flatMap((row) => row.lines.map(lineText)).join('')).toContain('quoted');
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

    const layout = layoutMarkdown(document, { glyphs: GLYPHS, width: 40 });
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

    const layout = layoutMarkdown(document, { glyphs: GLYPHS, width: 40 });

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

  it('opens a mid-document heading with one blank line', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro text\n\n## Section'), {
      glyphs: GLYPHS,
      width: 40,
    });
    const heading = layout.rows[1];

    expect(heading?.blockKind).toBe('heading');
    expect(heading?.lines.map(lineText)).toEqual(['', 'Section']);
    expect(heading?.height).toBe(2);
    expect(layout.height).toBe(3);
  });

  it('keeps a document-leading heading flush with the top and rules it off', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('# Title\n\nbody'), {
      glyphs: GLYPHS,
      width: 40,
    });

    expect(layout.rows[0]?.lines.map(lineText)).toEqual(['Title', RULE.repeat('Title'.length)]);
    expect(layout.rows[0]?.height).toBe(2);
    expect(layout.height).toBe(3);
  });

  it('separates the depth ranks so no two of the six read alike', () => {
    const rendered = ([1, 2, 3, 4, 5, 6] as const).map((depth) => {
      const rows = layoutMarkdown(parseMarkdownBlocks(`${'#'.repeat(depth)} Rank`), {
        glyphs: GLYPHS,
        width: 40,
      });
      const segments = rows.rows.flatMap((row) => row.lines.flatMap((line) => line.segments));
      return {
        depth,
        kinds: segments.map((segment) => segment.kind).join('+'),
        headingDepth: segments.find((segment) => segment.kind === 'heading')?.depth,
      };
    });

    expect(rendered.map((entry) => entry.headingDepth)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rendered[0]?.kinds).toBe('heading+rule');
    expect(rendered.slice(1).every((entry) => entry.kinds === 'heading')).toBe(true);
  });

  it('opens a leading heading with a blank line when an earlier block is reported', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('## Title'), {
      width: 40,
      glyphs: GLYPHS,
      previousBlock: { kind: 'paragraph', endsWithBlankLine: false },
    });

    expect(layout.rows[0]?.lines.map(lineText)).toEqual(['', 'Title']);
    expect(layout.rows[0]?.height).toBe(2);
    expect(layout.height).toBe(2);
  });

  it('does not double the air when the preceding block already closed on a blank line', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('## Title'), {
      width: 40,
      glyphs: GLYPHS,
      previousBlock: { kind: 'list', endsWithBlankLine: true },
    });

    expect(layout.rows[0]?.lines.map(lineText)).toEqual(['Title']);
  });

  it('opens a mid-document paragraph with one blank line', () => {
    expect(layoutLines('first para\n\nsecond para', 40)).toEqual(['first para', '', 'second para']);
  });

  it('keeps a label paragraph flush with the list or fence it introduces', () => {
    expect(layoutLines('intro\n\nDispatch rules:\n- one\n- two', 40)).toEqual([
      'intro',
      '',
      'Dispatch rules:',
      '• one',
      '• two',
    ]);
    expect(layoutLines('intro\n\nOptions:\n```\nvalue\n```', 40)).toEqual([
      'intro',
      '',
      'Options:',
      RAIL,
      `${RAIL} value`,
      RAIL,
    ]);
  });

  it('binds a heading to its body by dropping the body gap', () => {
    expect(layoutLines('intro\n\n## Section\n\nbody\n\nmore', 40)).toEqual([
      'intro',
      '',
      'Section',
      'body',
      '',
      'more',
    ]);
  });

  it('opens a mid-document thematic break with one blank line', () => {
    expect(layoutLines('intro\n\n---', 8)).toEqual(['intro', '', RULE.repeat(8)]);
  });

  it('ignores blocks that render nothing when deciding the next gap', () => {
    expect(layoutLines('intro\n\n## Section\n\n<!-- Q: ask -->\n\nbody', 40)).toEqual([
      'intro',
      '',
      'Section',
      'body',
    ]);
  });

  it('counts the gap once for a heading that wraps across lines', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro\n\n## Section title that wraps'), {
      width: 12,
      glyphs: GLYPHS,
    });
    const heading = layout.rows[1];

    expect(heading?.lines.map(lineText)).toEqual(['', 'Section', 'title that', 'wraps']);
    expect(heading?.height).toBe(4);
  });

  it('opens a heading that starts a blockquote with one blank line', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks('intro\n\n> ## Quoted\n> body'), {
      width: 40,
      glyphs: GLYPHS,
    });
    const quotedHeading = layout.rows[1];

    expect(quotedHeading?.blockKind).toBe('blockquote');
    expect(quotedHeading?.lines.map(lineText)).toEqual(['▎ ', '▎ Quoted']);
    expect(quotedHeading?.height).toBe(2);
  });

  it('binds a list-item continuation to its own bullet and closes the item below it', () => {
    expect(
      layoutLines('- A user starts a workflow.\n  Expected outcome: it completes.\n\n- Next.', 40),
    ).toEqual(['• A user starts a workflow.', '  Expected outcome: it completes.', '', '• Next.']);
  });

  it('hangs a wrapped continuation at the item text column, never at column 0', () => {
    const lines = layoutLines(
      '- Bullet text.\n  Expected outcome: a much longer sentence that has to wrap at this width.',
      32,
    );

    expect(lines[0]).toBe('• Bullet text.');
    expect(lines.slice(1, -1).every((line) => line === '' || line.startsWith('  '))).toBe(true);
    expect(lines.at(-1)).toBe('');
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

    const segments = layoutMarkdown(document, { glyphs: GLYPHS, width: 40 }).rows.flatMap((row) =>
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

    const layout = layoutMarkdown(document, { glyphs: GLYPHS, width: 40 });

    expect(layout.rows.length).toBeGreaterThan(0);
    expect(layout.rows.every((row) => row.blockKind === 'table')).toBe(true);
  });
});
