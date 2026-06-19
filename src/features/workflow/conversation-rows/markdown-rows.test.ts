import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import type { MarkdownLayoutSegment } from '../../../utils/markdown/types.js';
import { markdownConversationRows, workflowMarkdownRenderSegments } from './markdown-rows.js';
import { rowText } from './row-format.js';

describe('markdownConversationRows', () => {
  it('classifies workflow markers outside generic markdown parsing', () => {
    const rows = markdownConversationRows({
      keyPrefix: 'markdown',
      text: 'T001, T002, and T-06 update src/utils/markdown/layout.ts with HIGH risk: VERIFIED',
      width: 120,
    });
    const segments = rows.flatMap((row) => row.segments);

    expect(rows.map(rowText).join('\n')).toContain('T-06');
    expect(segments).toContainEqual({ text: 'T001', tone: 'accent', bold: true });
    expect(segments).toContainEqual({ text: 'T002', tone: 'accent', bold: true });
    expect(segments).toContainEqual({ text: 'src/utils/markdown/layout.ts', tone: 'reviewFile' });
    expect(segments).toContainEqual({ text: 'HIGH', tone: 'error', bold: true });
    expect(segments).toContainEqual({ text: 'VERIFIED', tone: 'success', bold: true });
    expect(segments).not.toContainEqual({ text: 'T-06', tone: 'accent', bold: true });
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
    expect(texts.filter((text) => /^─+$/.test(text))).toHaveLength(1);
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
  it('decorates review render segments with the same task-id boundary', () => {
    const theme = getTheme();
    const segment: MarkdownLayoutSegment = { kind: 'text', text: 'Review T001 and T-06' };

    const parts = workflowMarkdownRenderSegments({ segment, theme });

    expect(parts).toContainEqual({ text: 'T001', style: { color: theme.accent, bold: true } });
    expect(parts.find((part) => part.text.includes('T-06'))?.style).toBeUndefined();
  });
});
