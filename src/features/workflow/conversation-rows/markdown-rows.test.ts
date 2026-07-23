import { describe, expect, it } from 'vitest';
import { configStore } from '../../../stores/project/config.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import { layoutMarkdown } from '../../../utils/markdown/layout.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRows,
  markdownConversationRowsCacheKey,
  markdownConversationRowsProjection,
  resetMarkdownConversationRowsCache,
} from './markdown-rows.js';
import { rowText } from './row-format/rows.js';

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

function spanOffsets(start: number, end: number, count: number): number[] {
  const span = end - start;
  return Array.from(
    { length: count },
    (_, index) => start + Math.floor((span * (index + 1)) / (count + 1)),
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

  it('repairs the streaming tail chunk', () => {
    resetMarkdownConversationRowsCache();
    const text = 'before **bold text** after';
    const keyPrefix = 'markdown-tail-repair';
    let rows: MarkdownRows = [];

    for (let length = 1; length <= text.length; length += 1) {
      rows = markdownConversationRows({
        keyPrefix,
        text: text.slice(0, length),
        width: 80,
      });
      expect(rows.map(rowText).join('\n')).not.toContain('**');
    }

    expect(rows.map(rowText).join('\n')).toContain('before bold text after');
  });

  it('skips tail repair for a blockquote tail holding an open fence', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown-blockquote-tail',
      text: '> ```ts\n> const a = 1;',
      width: 60,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('const a = 1;');
    expect(text).not.toContain('const a = 1;`');
  });

  it('keeps a lone backtick literal in a table-shaped tail line', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown-table-tail',
      text: '| `code | x |',
      width: 60,
    });

    expect(rows.map(rowText).join('\n')).toContain('| `code | x |');
  });

  it('final append render equals from-scratch render', () => {
    const introText = 'Intro paragraph before the table.';
    const text = [
      introText,
      '',
      '| Name | Status |',
      '| --- | --- |',
      '| alpha | done |',
      '| beta | pending |',
      '| gamma | queued |',
      '',
      '**closing bold note**',
    ].join('\n');
    const width = 60;
    const keyPrefix = 'markdown-table-incremental';

    resetMarkdownConversationRowsCache();
    const cold = comparableRows(
      markdownConversationRows({ keyPrefix: 'markdown-table-cold', text, width }),
    );

    resetMarkdownConversationRowsCache();
    const lines = text.split('\n');
    let rows: MarkdownRows = [];
    for (const lineIndex of lines.keys()) {
      rows = markdownConversationRows({
        keyPrefix,
        text: lines.slice(0, lineIndex + 1).join('\n'),
        width,
      });
      expect(rows.map(rowText)).toContain(introText);
    }

    expect(comparableRows(rows)).toEqual(cold);
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

  it('leaves an external link target unresolved', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown',
        text: '[docs](https://example.com/docs)',
        width: 80,
      });
      const segments = rows.flatMap((row) => row.segments);

      expect(segments).toContainEqual({
        text: 'docs',
        tone: 'markdownLink',
        href: 'https://example.com/docs',
      });
      const text = rows.map(rowText).join('\n');
      expect(text).not.toContain('](');
      expect(text).not.toContain('https://example.com/docs');
    } finally {
      configStore.__testReset();
    }
  });
  it('links a project file-path reference and shortens its label', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown',
        text: 'update /repo/src/app/root.tsx:14 now',
        width: 80,
      });
      const segments = rows.flatMap((row) => row.segments);

      expect(segments).toContainEqual({
        text: 'src/app/root.tsx:14',
        tone: 'markdownLink',
        href: 'file:///repo/src/app/root.tsx',
      });
    } finally {
      configStore.__testReset();
    }
  });

  it('does not mint file hrefs for wrap-continuation fragments of a long path', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown-wrap-continuation',
        text: 'see /repo/src/features/workflow/components/input-footer.tsx:12 now',
        width: 30,
      });

      for (const segment of rows.flatMap((row) => row.segments)) {
        if (segment.href !== undefined) {
          expect(segment.href).toBe(
            'file:///repo/src/features/workflow/components/input-footer.tsx',
          );
        }
      }
      expect(JSON.stringify(rows)).not.toContain('/mponents/');
    } finally {
      configStore.__testReset();
    }
  });

  it('does not mint file hrefs for wrap-continuation fragments inside a blockquote', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown-wrap-continuation-blockquote',
        text: '> see /repo/src/features/workflow/components/input-footer.tsx:12 now',
        width: 30,
      });

      for (const segment of rows.flatMap((row) => row.segments)) {
        expect(segment.href).not.toBe('file:///repo/components/input-footer.tsx');
        if (segment.href !== undefined) {
          expect(segment.href).toBe(
            'file:///repo/src/features/workflow/components/input-footer.tsx',
          );
        }
      }
    } finally {
      configStore.__testReset();
    }
  });

  it('does not mint file hrefs for wrap-continuation fragments inside a list item', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown-wrap-continuation-list',
        text: '- see /repo/src/features/workflow/components/input-footer.tsx:12 now',
        width: 30,
      });

      for (const segment of rows.flatMap((row) => row.segments)) {
        expect(segment.href).not.toBe('file:///repo/components/input-footer.tsx');
        if (segment.href !== undefined) {
          expect(segment.href).toBe(
            'file:///repo/src/features/workflow/components/input-footer.tsx',
          );
        }
      }
    } finally {
      configStore.__testReset();
    }
  });

  it('resolves a markdown link to a project file as a file URL and shortens its label', () => {
    configStore.__testReset({ projectDir: '/repo' });
    try {
      const rows = markdownConversationRows({
        keyPrefix: 'markdown',
        text: '[src/app/root.tsx:14](src/app/root.tsx:14)',
        width: 80,
      });
      const segments = rows.flatMap((row) => row.segments);

      expect(segments).toContainEqual({
        text: 'src/app/root.tsx:14',
        tone: 'markdownLink',
        href: 'file:///repo/src/app/root.tsx',
      });
    } finally {
      configStore.__testReset();
    }
  });
});

describe('streaming tail repair', () => {
  const boldText = 'before **bold text example content** after';
  const boldOpenerEnd = boldText.indexOf('**') + 2;
  const boldCloserStart = boldText.indexOf('**', boldOpenerEnd);

  it.each(
    spanOffsets(boldOpenerEnd, boldCloserStart, 6),
  )('keeps a mid-** split styled with no dangling delimiter at offset %i', (offset) => {
    const keyPrefix = `streaming-bold-${offset}`;
    resetMarkdownConversationRowsCache();
    markdownConversationRows({ keyPrefix, text: '', width: 80 });
    const intermediate = markdownConversationRows({
      keyPrefix,
      text: boldText.slice(0, offset),
      width: 80,
    });
    expect(intermediate.map(rowText).join('\n')).not.toContain('**');

    const final = markdownConversationRows({ keyPrefix, text: boldText, width: 80 });
    const scratch = markdownConversationRows({
      keyPrefix: `${keyPrefix}-scratch`,
      text: boldText,
      width: 80,
    });
    expect(comparableRows(final)).toEqual(comparableRows(scratch));
  });

  const strikeText = 'before ~~strike text example content~~ after';
  const strikeOpenerEnd = strikeText.indexOf('~~') + 2;
  const strikeCloserStart = strikeText.indexOf('~~', strikeOpenerEnd);

  it.each(
    spanOffsets(strikeOpenerEnd, strikeCloserStart, 6),
  )('keeps a mid-~~ split styled with no dangling delimiter at offset %i', (offset) => {
    const keyPrefix = `streaming-strike-${offset}`;
    resetMarkdownConversationRowsCache();
    markdownConversationRows({ keyPrefix, text: '', width: 80 });
    const intermediate = markdownConversationRows({
      keyPrefix,
      text: strikeText.slice(0, offset),
      width: 80,
    });
    expect(intermediate.map(rowText).join('\n')).not.toContain('~~');

    const final = markdownConversationRows({ keyPrefix, text: strikeText, width: 80 });
    const scratch = markdownConversationRows({
      keyPrefix: `${keyPrefix}-scratch`,
      text: strikeText,
      width: 80,
    });
    expect(comparableRows(final)).toEqual(comparableRows(scratch));
  });

  const fenceText = [
    'before',
    '```ts',
    'const a = 1;',
    'const b = 2;',
    'const c = 3;',
    'const d = 4;',
    'const e = 5;',
    '```',
    'after',
  ].join('\n');
  const fenceOpenerEnd = fenceText.indexOf('\n', fenceText.indexOf('```ts')) + 1;
  const fenceCloserStart = fenceText.lastIndexOf('```');

  it.each(
    spanOffsets(fenceOpenerEnd, fenceCloserStart, 6),
  )('keeps a mid-fence split styled with no dangling delimiter at offset %i', (offset) => {
    const keyPrefix = `streaming-fence-${offset}`;
    resetMarkdownConversationRowsCache();
    markdownConversationRows({ keyPrefix, text: '', width: 80 });
    const intermediate = markdownConversationRows({
      keyPrefix,
      text: fenceText.slice(0, offset),
      width: 80,
    });
    expect(intermediate.map(rowText).join('\n')).not.toContain('```');

    const final = markdownConversationRows({ keyPrefix, text: fenceText, width: 80 });
    const scratch = markdownConversationRows({
      keyPrefix: `${keyPrefix}-scratch`,
      text: fenceText,
      width: 80,
    });
    expect(comparableRows(final)).toEqual(comparableRows(scratch));
  });
});

describe('q-marker invisibility', () => {
  const questionMarker =
    '<!-- Q:{"id":"q1","type":"choice","text":"?","options":["a","b"],"default":0} -->';
  const prefixEnd = questionMarker.indexOf('{');
  const jsonEnd = questionMarker.lastIndexOf('}');
  const suffixStart = jsonEnd + 1;
  const splitOffsets: ReadonlyArray<readonly [string, number]> = [
    ['inside the <!-- Q: prefix', 6],
    ['inside the JSON body', Math.floor((prefixEnd + jsonEnd) / 2)],
    ['at the JSON close, before -->', suffixStart],
    ['inside the --> closer', suffixStart + 2],
  ];

  it('hides a complete marker with zero visible rows', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'q-marker-complete',
      text: questionMarker,
      width: 80,
    });

    expect(rows).toHaveLength(0);
  });

  it.each(splitOffsets)('hides the marker split %s', (_label, offset) => {
    const keyPrefix = `q-marker-split-${offset}`;
    resetMarkdownConversationRowsCache();
    markdownConversationRows({ keyPrefix, text: '', width: 80 });
    const intermediate = markdownConversationRows({
      keyPrefix,
      text: questionMarker.slice(0, offset),
      width: 80,
    });
    expect(intermediate).toHaveLength(0);

    const final = markdownConversationRows({ keyPrefix, text: questionMarker, width: 80 });
    expect(final).toHaveLength(0);
  });

  it('hides a generic html comment with zero visible rows', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'q-marker-generic-comment',
      text: '<!-- note -->',
      width: 80,
    });

    expect(rows).toHaveLength(0);
  });
});

describe('links and tables in transcript rows', () => {
  it('renders a pipe table with border and header tones and no raw separator text', () => {
    const tableText = [
      '| Name | Status |',
      '| --- | --- |',
      '| alpha | done |',
      '| beta | pending |',
    ].join('\n');
    const rows = markdownConversationRows({
      keyPrefix: 'links-tables-pipe-table',
      text: tableText,
      width: 80,
    });
    const segments = rows.flatMap((row) => row.segments);

    expect(segments).toContainEqual({ text: 'Name', tone: 'markdownHeading', bold: true });
    expect(segments).toContainEqual({ text: 'Status', tone: 'markdownHeading', bold: true });
    expect(segments.some((segment) => segment.tone === 'markdownTableBorder')).toBe(true);
    const text = rows.map(rowText).join('\n');
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
  });

  it('wraps an overflow-width table without any row exceeding the layout width', () => {
    const width = 24;
    const tableText = [
      '| Name | Description |',
      '| --- | --- |',
      '| alpha | a very long description that will not fit on one line for sure |',
      '| beta | another sufficiently long description to force wrapping too |',
    ].join('\n');
    const rows = markdownConversationRows({
      keyPrefix: 'links-tables-overflow-table',
      text: tableText,
      width,
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const rowValue of rows) {
      expect(getTerminalCellWidth(rowText(rowValue))).toBeLessThanOrEqual(width);
    }
  });
});

describe('heading tone unification', () => {
  it.each([
    1, 2, 3, 4, 5, 6,
  ] as const)('gives depth %d headings the shared markdownHeading tone with bold only at depth <= 3', (depth) => {
    const marker = '#'.repeat(depth);
    const rows = markdownConversationRows({
      keyPrefix: `heading-tone-depth-${depth}`,
      text: `${marker} Heading text`,
      width: 80,
    });
    const segments = rows.flatMap((row) => row.segments);

    expect(segments).toContainEqual({
      text: 'Heading text',
      tone: 'markdownHeading',
      bold: depth <= 3,
    });
  });
});

describe('highlighted code in transcript rows', () => {
  it('renders a ts fence with at least two distinct syntax tones', () => {
    const text = ['```ts', "const x = 'y';", '```'].join('\n');
    const projection = markdownConversationRowsProjection({
      keyPrefix: 'highlight-ts-fence',
      text,
      width: 80,
    });
    const rows = projection.createRows(0, projection.rowCount);
    const tones = rows.flatMap((row) => row.segments.map((segment) => segment.tone));
    const syntaxTones = new Set(tones.filter((tone) => tone?.startsWith('syntax')));

    expect(syntaxTones.size).toBeGreaterThanOrEqual(2);
  });

  it('keeps an unknown-tag fence monochrome with no syntax tone and no lost text', () => {
    const text = ['```zzz', "const x = 'y';", '```'].join('\n');
    const projection = markdownConversationRowsProjection({
      keyPrefix: 'highlight-zzz-fence',
      text,
      width: 80,
    });
    const rows = projection.createRows(0, projection.rowCount);
    const tones = rows.flatMap((row) => row.segments.map((segment) => segment.tone));

    expect(tones.some((tone) => tone?.startsWith('syntax'))).toBe(false);
    expect(rows.map(rowText).join('\n')).toContain("const x = 'y';");
  });
});
