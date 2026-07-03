import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import { layoutMarkdown } from '../../../utils/markdown/layout.js';
import type { MarkdownLayoutSegment } from '../../../utils/markdown/types.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRows,
  markdownConversationRowsCacheKey,
  markdownConversationRowsProjection,
  resetMarkdownConversationRowsCache,
  workflowMarkdownRenderSegments,
} from './markdown-rows.js';
import { rowText } from './row-format.js';

const THEMATIC_BREAK_CHAR = '\u2500';

type MarkdownRows = ReturnType<typeof markdownConversationRows>;

function comparableRows(rows: MarkdownRows): Pick<MarkdownRows[number], 'kind' | 'segments'>[] {
  return rows.map(({ kind, segments }) => ({ kind, segments }));
}

function appendedLineByLineRows(input: { keyPrefix: string; text: string; width: number }) {
  const lines = input.text.split('\n');
  let rows = markdownConversationRows({ ...input, text: '' });
  for (const lineIndex of lines.keys()) {
    rows = markdownConversationRows({
      ...input,
      text: lines.slice(0, lineIndex + 1).join('\n'),
    });
  }
  return rows;
}

function appendedCharacterByCharacterRows(input: {
  keyPrefix: string;
  text: string;
  width: number;
}) {
  let rows = markdownConversationRows({ ...input, text: '' });
  for (let length = 1; length <= input.text.length; length += 1) {
    rows = markdownConversationRows({
      ...input,
      text: input.text.slice(0, length),
    });
  }
  return rows;
}

function canonicalMarkdownLineText(text: string, width: number): string[] {
  const layout = layoutMarkdown(parseMarkdownBlocks(text), { width });
  return layout.rows.flatMap((layoutRow) =>
    layoutRow.lines.map((line) => line.segments.map((segment) => segment.text).join('')),
  );
}

function markdownListText(eventIndex: number, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, lineIndex) =>
      `- T${String((lineIndex % 999) + 1).padStart(3, '0')} event ${eventIndex} update src/file-${lineIndex}.ts`,
  ).join('\n');
}

describe('markdownConversationRows', () => {
  it('classifies workflow markers outside generic markdown parsing', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: 'T001, T002, and T-06 update src/utils/markdown/layout.ts with HIGH risk: VERIFIED',
      width: 120,
    });
    const segments = rows.flatMap((row) => row.segments);

    expect(rows.map(rowText).join('\n')).toContain('T-06');
    expect(segments).toContainEqual({ text: 'T001', tone: 'text', bold: true });
    expect(segments).toContainEqual({ text: 'T002', tone: 'text', bold: true });
    expect(segments).toContainEqual({ text: 'src/utils/markdown/layout.ts', tone: 'textDim' });
    expect(segments).toContainEqual({ text: 'HIGH', tone: 'textDim' });
    expect(segments).toContainEqual({ text: 'VERIFIED', tone: 'textDim' });
    expect(segments).not.toContainEqual({ text: 'T-06', tone: 'text', bold: true });
  });

  it('renders task brief metadata without turning its delimiters into rules', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: [
        '---',
        'id: T001',
        'title: Add parser support',
        'action: modify',
        'file: src/utils/markdown/block-parser.ts',
        'depends_on: []',
        '---',
        '### Description',
        'Parse task metadata.',
        '',
        '---',
        '',
        'ordinary break',
        '',
        '---',
        'id: T002',
        'title: Add row coverage',
        'action: modify',
        'file: src/features/workflow/conversation-rows/markdown-rows.test.ts',
        'depends_on:',
        '  - T001',
        '---',
        '### Description',
        'Render task metadata.',
      ].join('\n'),
      width: 80,
    });
    const texts = rows.map(rowText);

    expect(texts).toContain('id: T001');
    expect(texts).toContain('depends_on: []');
    expect(texts).toContain('id: T002');
    expect(texts).toContain('depends_on:');
    expect(texts).toContain('  - T001');
    expect(texts.filter((text) => text === THEMATIC_BREAK_CHAR.repeat(text.length))).toHaveLength(
      1,
    );
  });

  it('strips terminal controls from conversation markdown rows', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: 'visible\u001b[31m WARN\u001b[0m \u001b]52;c;clipboard\u0007done\u0007',
      width: 80,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('visible WARN done');
    expect(text).not.toContain('clipboard');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  it('redacts secrets before laying out conversation markdown rows', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: `planner secret ${secret}`,
      width: 80,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('REDACTED');
    expect(text).not.toContain(secret);
  });

  it('reuses cached layout for identical markdown and invalidates on width changes', () => {
    resetMarkdownConversationRowsCache();
    const input = {
      keyPrefix: 'markdown-cache',
      text: '### Heading\n\nLong content that wraps around a narrow terminal width.',
      width: 40,
    };

    const first = markdownConversationRowsProjection(input);
    const second = markdownConversationRowsProjection(input);
    const widthChanged = markdownConversationRowsProjection({ ...input, width: 20 });

    expect(second).toBe(first);
    expect(widthChanged).not.toBe(first);
  });

  it('retains newest active markdown entries when a projection pass exceeds the cache cap', () => {
    resetMarkdownConversationRowsCache();
    const width = 96;
    const entries = Array.from({ length: 30 }, (_, index) => ({
      keyPrefix: `event-${index}-planner_text`,
      text: markdownListText(index, 500),
      width,
    }));
    const endProjectionPass = beginMarkdownConversationRowsProjectionPass(
      entries.map(markdownConversationRowsCacheKey),
    );
    const projections: ReturnType<typeof markdownConversationRowsProjection>[] = [];

    try {
      for (const entry of entries) {
        projections.push(markdownConversationRowsProjection(entry));
      }
    } finally {
      endProjectionPass();
    }

    for (const [index, entry] of entries.slice(6).entries()) {
      expect(markdownConversationRowsProjection(entry)).toBe(projections[index + 6]);
    }
    for (const [index, entry] of entries.slice(0, 6).entries()) {
      expect(markdownConversationRowsProjection(entry)).not.toBe(projections[index]);
    }
  });

  it('keeps appended metadata rows equivalent to a cold render', () => {
    const examples = [
      {
        name: 'task',
        text: [
          '---',
          'id: T001',
          'title: Add parser support',
          'action: modify',
          'file: src/utils/markdown/block-parser.ts',
          'depends_on:',
          '  - T000',
          '---',
          '### Description',
          'Parse task metadata.',
        ].join('\n'),
      },
      {
        name: 'frontmatter',
        text: [
          '---',
          'title: Markdown core',
          'owner: docs',
          '---',
          '# Markdown core',
          'Render frontmatter incrementally.',
        ].join('\n'),
      },
    ];

    for (const example of examples) {
      resetMarkdownConversationRowsCache();
      const cold = comparableRows(
        markdownConversationRows({
          keyPrefix: `markdown-${example.name}-cold`,
          text: example.text,
          width: 80,
        }),
      );

      resetMarkdownConversationRowsCache();
      const lineByLine = appendedLineByLineRows({
        keyPrefix: `markdown-${example.name}-incremental`,
        text: example.text,
        width: 80,
      });

      resetMarkdownConversationRowsCache();
      const charByChar = appendedCharacterByCharacterRows({
        keyPrefix: `markdown-${example.name}-incremental`,
        text: example.text,
        width: 80,
      });

      expect(comparableRows(lineByLine)).toEqual(cold);
      expect(comparableRows(charByChar)).toEqual(cold);
    }
  });

  it('keeps long appended paragraphs equivalent to canonical markdown layout', () => {
    const words = Array.from({ length: 520 }, (_, index) => `word-${index}`);
    const text = words.join(' ');
    const prefix = words.slice(0, -1).join(' ');
    const width = 48;
    const canonical = canonicalMarkdownLineText(text, width);

    resetMarkdownConversationRowsCache();
    const cold = markdownConversationRows({
      keyPrefix: 'markdown-long-paragraph-cold',
      text,
      width,
    });

    resetMarkdownConversationRowsCache();
    markdownConversationRows({
      keyPrefix: 'markdown-long-paragraph-incremental',
      text: prefix,
      width,
    });
    const appended = markdownConversationRows({
      keyPrefix: 'markdown-long-paragraph-incremental',
      text,
      width,
    });

    expect(cold.map(rowText)).toEqual(canonical);
    expect(appended.map(rowText)).toEqual(canonical);
    expect(comparableRows(appended)).toEqual(comparableRows(cold));
  });

  it('wraps CJK, emoji, and combining marks by terminal cells', () => {
    const developerEmoji = '👩‍💻';
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: `${'界'.repeat(6)} ${developerEmoji.repeat(5)} ${'e\u0301'.repeat(10)} src/界語/${developerEmoji}/file.ts`,
      width: 10,
    });
    const lines = rows.map(rowText);
    const joined = lines.join('');

    expect(lines.every((line) => getTerminalCellWidth(line) <= 10)).toBe(true);
    expect(joined).toContain(developerEmoji.repeat(5));
    expect(joined).toContain('e\u0301'.repeat(10));
  });
});

describe('workflowMarkdownRenderSegments', () => {
  it('colors only the status word, leaving the doc region free of accent/state hues', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = {
      kind: 'text',
      text: 'T001 in src/foo.ts is HIGH risk and FAILED',
    };

    const parts = workflowMarkdownRenderSegments({ segment, theme });

    expect(parts).toContainEqual({ text: 'T001' });
    expect(parts).toContainEqual({ text: 'src/foo.ts', style: { color: theme.textDim } });
    expect(parts).toContainEqual({ text: 'HIGH' });
    expect(parts).toContainEqual({
      text: 'FAILED',
      style: { color: theme.dimError, bold: false },
    });
    expect(
      parts.every(
        (part) =>
          part.text === 'FAILED' || part.style === undefined || part.style.color === theme.textDim,
      ),
    ).toBe(true);
  });

  it('does not color short prose verdict words on the doc surface', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = {
      kind: 'text',
      text: 'all checks PASS and tasks DONE, nothing is OK to skip',
    };

    const parts = workflowMarkdownRenderSegments({ segment, theme });

    expect(parts.every((part) => part.style === undefined)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(
      'all checks PASS and tasks DONE, nothing is OK to skip',
    );
  });

  it('folds an inconclusive verdict to a dim word on the doc surface', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = { kind: 'text', text: 'result is INCONCLUSIVE' };

    const parts = workflowMarkdownRenderSegments({ segment, theme });

    expect(parts).toContainEqual({
      text: 'INCONCLUSIVE',
      style: { color: theme.textDim, bold: false },
    });
  });
});
