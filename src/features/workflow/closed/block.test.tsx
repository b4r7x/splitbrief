import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { taskId } from '../../../core/schemas/task.js';
import { terminalTheme } from '../../../components/theme.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import { glyph } from '../../../lib/glyphs.js';
import { deriveSummaryView } from './view-model.js';
import { closedBlockRows } from './block.js';

function closedRows(width: number): ScrollableDocumentRow[] {
  resetAllStores();
  const view = deriveSummaryView({
    record: makeRunRecord({
      ref: { projectDir: '/tmp/closed-block', sessionId: 'block-session' },
      summary: makeSummary({
        feature: 'Add email validation with tests',
        totalTasks: 1,
        completedByLocal: 1,
        changedFiles: ['src/validate.ts'],
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'Add the validator',
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
        ],
      }),
      status: { kind: 'closed', as: 'complete' },
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  return closedBlockRows({ view, width, theme: terminalTheme, crewNamed: true });
}

function renderRows(rows: ScrollableDocumentRow[], width: number) {
  return renderFeature(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>,
    { cols: width, rows: 30 },
  );
}

function renderRow(row: ScrollableDocumentRow, width: number): string {
  const ui = renderRows([row], width);
  const line = stripAnsiStyles(ui.lastFrame() ?? '').split('\n')[0] ?? '';
  ui.unmount();
  return line;
}

function firstLineStartingWith(frame: string, needle: string): string {
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.startsWith(needle)) ?? ''
  );
}

describe('closedBlockRows', () => {
  it('opens every ledger row on the transcript\'s own two columns', () => {
    const width = 60;
    const rows = closedRows(width);
    const ui = renderRows(rows, width);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // One column short of the full width: the rule stops before the column the composer's right
    // stroke stands in rather than overhanging it.
    const closedRule = firstLineStartingWith(frame, '   Closed ');
    expect(closedRule).toContain(glyph('divider'));
    expect(closedRule.trimEnd().length).toBe(width - 1);

    expect(frame).toContain('   Add email validation with tests');

    const runRule = firstLineStartingWith(frame, '   Run ');
    expect(runRule).toContain(glyph('divider'));
    expect(runRule.trimEnd().length).toBe(width - 1);

    expect(firstLineStartingWith(frame, '   Review  ')).not.toBe('');

    ui.unmount();

    // A ledger row is either marked — the outcome and the brief rows, whose mark lands on column 1
    // — or bare text on column 3. A spacer row carries no ink, so it is left out rather than
    // counted as a row that opens in column 0.
    const inked = rows.map((row) => renderRow(row, width).search(/\S/)).filter((ink) => ink !== -1);
    expect(inked.length).toBeGreaterThan(0);
    expect(inked.every((ink) => ink === 1 || ink === 3)).toBe(true);
    expect(inked).toContain(1);
    expect(inked).toContain(3);
  });
});
