import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { eventRowBlock, eventRows } from './event-rows.js';
import { rowText } from './row-format.js';
import type { ConversationRow } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

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

function isBordered(rows: ReturnType<typeof rowsFor>): boolean {
  return rows.some((rowValue) => rowValue.kind === 'card-top');
}

describe('eventRows bordered cards', () => {
  it('renders error events as a bordered card with error-toned label and body', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'typecheck failed',
    };

    const rows = rowsFor(event);
    const text = rows.map(rowText).join('\n');

    expect(isBordered(rows)).toBe(true);
    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toMatch(/^┌─ error/);
    expect(topRow.segments[0]?.tone).toBe('border');
    expect(topRow.segments[1]?.tone).toBe('error');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-body');
    expect(rowText(bodyRow)).toContain('typecheck failed');
    expect(bodyRow.segments[1]?.tone).toBe('error');

    const bottomRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-bottom');
    expect(rowText(bottomRow)).toMatch(/└/);

    expect(text).toContain('┌─ error');
    expect(text).toContain('└');
  });

  it('renders budget_warning as a bordered card with warning tone', () => {
    const event: EngineEventOf<'budget_warning'> = {
      type: 'budget_warning',
      ts: 0,
      phase: 'implementing',
      currentCost: 8_000,
      maxBudget: 10_000,
    };

    const rows = rowsFor(event);

    expect(isBordered(rows)).toBe(true);
    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toMatch(/^┌─ budget/);
    expect(topRow.segments[1]?.tone).toBe('warning');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-body');
    expect(rowText(bodyRow)).toContain('80% reached');
    expect(bodyRow.segments[1]?.tone).toBe('warning');
  });

  it('keeps task_skipped as a flat row without card borders', () => {
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

    expect(isBordered(rows)).toBe(false);
    expect(text).not.toContain('┌');
    expect(text).not.toContain('└');
    expect(text).toContain('T001 Validate no-op workflow: dependency failed');
    expect(rows[0]?.kind).toBe('card');
  });

  it('renders recovery_prompted as a bordered card with warning-toned label and body', () => {
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

    expect(isBordered(rows)).toBe(true);
    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toMatch(/^┌─ recovery/);
    expect(topRow.segments[1]?.tone).toBe('warning');

    const bodyRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-body');
    expect(rowText(bodyRow)).toContain('validation-failed');
    expect(rowText(bodyRow)).toContain('retry-same-worker');
    expect(bodyRow.segments[1]?.tone).toBe('warning');
  });

  it('fits bordered card rows to terminal cell width for long path bodies', () => {
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

    expect(isBordered(rows)).toBe(true);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('fits bordered card rows to terminal cell width for wide glyph bodies', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'ビルド失敗 🚨 日本語ラベルと絵文字を含むエラーメッセージ',
    };
    const width = 40;

    const rows = rowsFor(event, width);

    expect(isBordered(rows)).toBe(true);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('renders bottom border middle segments with border tone', () => {
    const event: EngineEventOf<'error'> = {
      type: 'error',
      ts: 0,
      phase: 'implementing',
      message: 'failed',
    };

    const rows = rowsFor(event);
    const bottomRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-bottom');
    const middleSegments = bottomRow.segments.filter(
      (segment) =>
        segment.text.trim().length > 0 &&
        !segment.text.includes('└') &&
        !segment.text.includes('┘'),
    );

    expect(middleSegments.length).toBeGreaterThan(0);
    expect(middleSegments.every((segment) => segment.tone === 'border')).toBe(true);
  });

  it('materializes only the requested row window for large bordered card bodies', () => {
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
    const topRow = requireRow(windowRows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toMatch(/^┌─ error/);

    const bodyWindowRows = block?.createRows(1, 2) ?? [];
    expect(bodyWindowRows).toHaveLength(1);
    const bodyRow = requireRow(bodyWindowRows, (rowValue) => rowValue.kind === 'card-body');
    expect(rowText(bodyRow)).toContain('error line 1');
    expect(rowText(bodyRow)).not.toContain('error line 2');
  });
});
