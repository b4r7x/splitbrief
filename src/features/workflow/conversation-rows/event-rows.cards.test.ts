import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { glyph } from '../../../lib/glyphs.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { calloutRowsBlock } from './callout-block.js';
import { eventRowBlock } from './event-rows/dispatch.js';
import { cardRowsBlock } from './row-block-compose.js';
import { wrapWidthFor } from './row-markers.js';
import { rowText } from './row-format/rows.js';
import type { ConversationRow } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
const RULE = glyph('treeMid');

function rowsFor(event: EngineEvent, width = 80) {
  return eventRows({
    event,
    globalIndex: 0,
    expanded: false,
    ctx: { width, viewportRows: 20, streaming },
  });
}

function requireRow(
  rows: ConversationRow[],
  matcher: (row: ConversationRow) => boolean,
): ConversationRow {
  const found = rows.find(matcher);
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error('requireRow: row not found');
  }
  return found;
}

function hasLabelRow(rows: ReturnType<typeof rowsFor>): boolean {
  return rows.some((rowValue) => rowValue.kind === 'card-top' || rowValue.kind === 'callout-top');
}

function hasFrameGlyphs(rows: ReturnType<typeof rowsFor>): boolean {
  const text = rows.map(rowText).join('\n');
  return /[┌┐└┘├┤+]/.test(text);
}

function hasLeftRule(rows: ReturnType<typeof rowsFor>): boolean {
  return rows.some(
    (rowValue) => rowValue.kind === 'callout-top' || rowValue.kind === 'callout-body',
  );
}

describe('eventRows colored left-rule callouts', () => {
  it('emits callout kinds whose leading carries the rule, with no bar in the text', () => {
    const block = calloutRowsBlock({
      keyPrefix: 'w',
      label: 'warning',
      value: 'Something went sideways',
      width: 40,
      severity: 'warning',
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];
    expect(rows[0]?.kind).toBe('callout-top');
    expect(rows.slice(1).every((row) => row.kind === 'callout-body')).toBe(true);
    for (const row of rows) {
      expect(row.segments[0]?.text.includes('│')).toBe(false);
    }
  });

  it('renders error events as a red left rule + red label + dim body, no box frame', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'typecheck failed',
    };

    const rows = rowsFor(event);

    expect(hasLabelRow(rows)).toBe(true);
    expect(hasLeftRule(rows)).toBe(true);
    expect(hasFrameGlyphs(rows)).toBe(false);

    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'callout-top');
    expect(topRow.markerTone).toBe('error');
    expect(topRow.segments[0]?.tone).toBe('error');
    expect(rowText(topRow)).not.toContain(RULE);
    expect(rowText(topRow)).toContain('error');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'callout-body');
    expect(bodyRow.markerTone).toBe('error');
    expect(rowText(bodyRow)).not.toContain(RULE);
    expect(rowText(bodyRow)).toContain('typecheck failed');
    expect(bodyRow.segments[0]?.tone).toBe('textDim');
  });

  it('renders budget_warning as a yellow left rule + yellow label + dim body', () => {
    const event: EngineEventOf<'budget_warning'> = {
      type: 'budget_warning',
      ts: 0,
      phase: 'implementing',
      currentCost: 8_000,
      maxBudget: 10_000,
    };

    const rows = rowsFor(event);

    expect(hasLabelRow(rows)).toBe(true);
    expect(hasLeftRule(rows)).toBe(true);
    expect(hasFrameGlyphs(rows)).toBe(false);

    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'callout-top');
    expect(topRow.markerTone).toBe('warning');
    expect(topRow.segments[0]?.tone).toBe('warning');
    expect(rowText(topRow)).toContain('budget');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'callout-body');
    expect(rowText(bodyRow)).toContain('80% reached');
    expect(bodyRow.segments[0]?.tone).toBe('textDim');
  });

  it('routes budget_exceeded through a red left rule (hard stop, not yellow)', () => {
    const event: EngineEventOf<'budget_exceeded'> = {
      type: 'budget_exceeded',
      ts: 0,
      phase: 'implementing',
      currentCost: 12_000,
      maxBudget: 10_000,
    };

    const rows = rowsFor(event);
    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'callout-top');
    expect(topRow.markerTone).toBe('error');
    expect(topRow.segments[0]?.tone).toBe('error');
    expect(rowText(topRow)).toContain('budget');
  });

  it('keeps task_skipped as a flat row with no label header and no left rule', () => {
    const event: EngineEventOf<'task_skipped'> = {
      type: 'task_skipped',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Validate no-op workflow',
      reason: 'dependency failed',
    };

    const rows = rowsFor(event);
    const text = rows.map(rowText).join('\n');

    expect(hasLabelRow(rows)).toBe(false);
    expect(hasLeftRule(rows)).toBe(false);
    expect(text).not.toContain(RULE);
    expect(text).toContain('T001 Validate no-op workflow: dependency failed');
    expect(text).not.toContain('TT001');
    expect(rows[0]?.kind).toBe('card');
  });

  it('keeps recovery_prompted as a quiet de-boxed card, no left rule', () => {
    const event: EngineEventOf<'recovery_prompted'> = {
      type: 'recovery_prompted',
      ts: 0,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      recommendedAction: 'retry-same-worker',
      taskId: taskId('T001'),
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker'],
    };

    const rows = rowsFor(event);

    expect(hasLabelRow(rows)).toBe(true);
    expect(hasLeftRule(rows)).toBe(false);
    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toContain('recovery');
    expect(topRow.segments[0]?.tone).toBe('textDim');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-body');
    expect(rowText(bodyRow)).toContain('validation-failed');
    expect(rowText(bodyRow)).toContain('retry-same-worker');
  });

  it('does not append its own trailing blank row (build.ts owns inter-block spacing)', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'failed',
    };

    const rows = rowsFor(event);
    const last = rows.at(-1);
    expect(last?.kind).not.toBe('spacer');
    expect(last?.kind).toBe('callout-body');
  });

  it('fits left-rule callout rows to terminal cell width for long path bodies', () => {
    const longPath =
      'src/features/workflow/conversation-rows/' + 'very/deep/nested/'.repeat(12) + 'module.ts';
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: `typecheck failed at ${longPath}:42:10`,
    };
    const width = 48;

    const rows = rowsFor(event, width);

    expect(hasLeftRule(rows)).toBe(true);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('fits left-rule callout rows to terminal cell width for wide glyph bodies', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'ビルド失敗 🚨 日本語ラベルと絵文字を含むエラーメッセージ',
    };
    const width = 40;

    const rows = rowsFor(event, width);

    expect(hasLeftRule(rows)).toBe(true);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('materializes only the requested row window for large left-rule callout bodies', () => {
    const largeBody = Array.from(
      { length: 40 },
      (_, index) => `error line ${index + 1}: ${'x'.repeat(80)}`,
    ).join('\n');
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: largeBody,
    };

    const block = eventRowBlock({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 40, viewportRows: 20, streaming },
    });

    expect(block).not.toBeNull();
    expect(block?.rowCount).toBeGreaterThan(10);

    const windowRows = block?.createRows(0, 1) ?? [];
    expect(windowRows).toHaveLength(1);
    const topRow = requireRow(windowRows, (rowValue) => rowValue.kind === 'callout-top');
    expect(topRow.markerTone).toBe('error');
    expect(rowText(topRow)).toContain('error');

    const bodyWindowRows = block?.createRows(1, 2) ?? [];
    expect(bodyWindowRows).toHaveLength(1);
    const bodyRow = requireRow(bodyWindowRows, (rowValue) => rowValue.kind === 'callout-body');
    expect(bodyRow.markerTone).toBe('error');
    expect(rowText(bodyRow)).toContain('error line 1');
    expect(rowText(bodyRow)).not.toContain('error line 2');
  });

  it('renders workflow activity rows as bounded compact rows', () => {
    const streamingCtx = {
      taskId: taskId('T001'),
      lines: ['streamed output'],
      active: true,
    };
    const cases = [
      {
        label: 'Planning plain text',
        event: {
          type: 'planner_text',
          ts: 0,
          phase: 'planning',
          role: 'planner',
          text: 'Planning plain text',
        } satisfies EngineEvent,
      },
      {
        label: 'Validate no-op workflow',
        event: {
          type: 'task_started',
          ts: 0,
          phase: 'implementing',
          taskId: taskId('T001'),
          title: 'Validate no-op workflow',
          index: 0,
          total: 1,
          file: 'README.md',
          action: 'modify',
          tool: 'codex',
          implementerProfile: 'default',
        } satisfies EngineEvent,
      },
      {
        label: 'generating README.md',
        event: {
          type: 'implementer_generate_running',
          ts: 0,
          phase: 'implementing',
          taskId: taskId('T001'),
          file: 'README.md',
        } satisfies EngineEvent,
      },
      {
        label: 'README.md',
        event: {
          type: 'implementer_generate_done',
          ts: 0,
          phase: 'implementing',
          taskId: taskId('T001'),
          file: 'README.md',
          diff: '+ added line\n- removed line',
          linesAdded: 1,
          linesRemoved: 1,
          duration: 1234,
        } satisfies EngineEvent,
      },
      {
        label: 'typecheck failed',
        event: {
          type: 'validate',
          ts: 0,
          phase: 'validating-task',
          taskId: taskId('T001'),
          status: 'done',
          passed: false,
          stages: { typecheck: false, lint: false, test: false },
          error: 'typecheck failed',
        } satisfies EngineEvent,
      },
      {
        label: 'retry with narrower scope',
        event: {
          type: 'escalate',
          ts: 0,
          phase: 'escalating',
          taskId: taskId('T001'),
          tier: 1,
          hint: 'retry with narrower scope',
        } satisfies EngineEvent,
      },
    ] as const;

    for (const { label, event } of cases) {
      const rows = eventRows({
        event,
        globalIndex: 0,
        expanded: true,
        ctx: { width: 80, viewportRows: 20, streaming: streamingCtx },
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map(rowText).join('\n')).toContain(label);
      expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
      expect(rows.every((rowValue) => rowValue.kind.length > 0)).toBe(true);
    }
  });
});

describe('cardRowsBlock label wrapping', () => {
  it('never paints a label wider than the wrapped line it sits on', () => {
    const width = 20;
    const block = cardRowsBlock({
      keyPrefix: 'c',
      label: 'attachments dropped',
      value: '2 images dropped (too large)',
      width,
      labelTone: 'textDim',
    });
    expect(block).not.toBeNull();
    if (block === null) return;

    const rows = block.createRows(0, block.rowCount);
    const wrapWidth = wrapWidthFor('card', width);
    for (const rowValue of rows) {
      expect(getTerminalCellWidth(rowText(rowValue))).toBeLessThanOrEqual(wrapWidth);
    }
  });
});
