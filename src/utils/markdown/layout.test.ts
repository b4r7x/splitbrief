import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../display-text.js';
import { parseMarkdownBlocks } from './block-parser.js';
import { layoutMarkdown } from './layout.js';
import type { MarkdownLayoutLine } from './types.js';

function lineText(line: MarkdownLayoutLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

function layoutLines(source: string, width: number): string[] {
  const layout = layoutMarkdown(parseMarkdownBlocks(source), { width });
  return layout.rows.flatMap((row) => row.lines.map(lineText));
}

describe('layoutMarkdown', () => {
  it('uses terminal width for thematic breaks', () => {
    expect(layoutLines('---', 12)).toEqual(['─'.repeat(12)]);
    expect(layoutLines('---', 28)).toEqual(['─'.repeat(28)]);
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
});
