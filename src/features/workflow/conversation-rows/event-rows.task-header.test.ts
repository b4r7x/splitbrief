import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { eventRows } from './event-rows.js';
import { rowText } from './row-format.js';
import type { ConversationRow } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function requireRow(rows: ConversationRow[], index: number): ConversationRow {
  const found = rows[index];
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error(`requireRow: row at index ${index} not found`);
  }
  return found;
}

function makeTaskStarted(
  overrides: Partial<Extract<EngineEvent, { type: 'task_started' }>> = {},
): Extract<EngineEvent, { type: 'task_started' }> {
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Route ordinary task',
    index: 0,
    total: 1,
    file: 'src/app.ts',
    action: 'modify',
    tool: 'codex',
    implementerProfile: 'cheap-cloud',
    contextFit: 'fits',
    estimatedTokens: 3911,
    contextLength: 32_768,
    routingReason: 'selected cheapest capable profile',
    ...overrides,
  };
}

function makeMarkdownPlannerText(
  overrides: Partial<Extract<EngineEvent, { type: 'planner_text' }>> = {},
): Extract<EngineEvent, { type: 'planner_text' }> {
  return {
    type: 'planner_text',
    ts: 0,
    phase: 'planning',
    content: 'markdown',
    text: [
      'id: T001',
      'title: Run no-op validation smoke check',
      '---',
      '',
      '### Description',
      'Smoke check.',
    ].join('\n'),
    ...overrides,
  };
}

describe('eventRows task header and planner phase header', () => {
  it('renders task_started as a segmented header (accent index, text title, textDim metadata)', () => {
    const event = makeTaskStarted();
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(0);
    const first = requireRow(rows, 0);
    expect(first.kind).toBe('task-header');
    expect(first.segments).toEqual([
      { text: 'T1', tone: 'accent', bold: true },
      { text: ' Route ordinary task', tone: 'text', bold: true },
      {
        text: '  src/app.ts (modify) · Codex · profile cheap-cloud · fit fits · why selected cheapest capable ',
        tone: 'textDim',
      },
    ]);
  });

  it('keeps title bold on wrapped continuation lines before metadata', () => {
    const event = makeTaskStarted({
      title: 'Alpha bravo charlie delta echo foxtrot golf hotel india',
      file: 'z.ts',
      action: 'modify',
      tool: 'codex',
      implementerProfile: 'cheap',
      contextFit: 'fits',
      routingReason: 'cheap',
    });
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 22, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(2);
    const metadataRowIndex = rows.findIndex((row) =>
      row.segments.some((segment) => segment.tone === 'textDim'),
    );
    expect(metadataRowIndex).toBeGreaterThan(1);

    for (const row of rows.slice(1, metadataRowIndex)) {
      expect(row.segments.every((segment) => segment.bold === true)).toBe(true);
      expect(row.segments.every((segment) => segment.tone === 'text')).toBe(true);
    }
  });

  it('keeps task_started rows tagged as task-header kind even when metadata wraps', () => {
    const event = makeTaskStarted({
      title: 'No-op workflow demonstration with enough metadata to wrap',
    });
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 40, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    for (const rowValue of rows) {
      expect(rowValue.kind).toBe('task-header');
    }
  });

  it('prepends RESEARCH header for researching-phase markdown planner text', () => {
    const event = makeMarkdownPlannerText({ phase: 'researching' });
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const first = rows[0];
    expect(first?.kind).toBe('message');
    expect(rowText(first ?? { key: 'missing', kind: 'message', segments: [] })).toBe('RESEARCH');
    expect(rowText(first ?? { key: 'missing', kind: 'message', segments: [] })).not.toBe('BRIEF');
    expect(first?.segments).toContainEqual({ text: 'RESEARCH', tone: 'planner', bold: true });
  });

  it('prepends a planner phase header (PLAN, planner tone, bold) for planning markdown', () => {
    const event = makeMarkdownPlannerText({ phase: 'planning' });
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const first = requireRow(rows, 0);
    expect(first.kind).toBe('message');
    expect(rowText(first)).toBe('PLAN');
    expect(first.segments).toContainEqual({ text: 'PLAN', tone: 'planner', bold: true });
  });

  it('prepends a planner phase header (RESEARCH, planner tone, bold) for researching markdown', () => {
    const event = makeMarkdownPlannerText({ phase: 'researching' });
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const first = requireRow(rows, 0);
    expect(first.kind).toBe('message');
    expect(rowText(first)).toBe('RESEARCH');
    expect(first.segments).toContainEqual({ text: 'RESEARCH', tone: 'planner', bold: true });
  });
});
