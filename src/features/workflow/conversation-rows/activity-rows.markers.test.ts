import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { rowMarker } from './row-markers.js';
import { rowText } from './row-format.js';
import type { ConversationRow } from './types.js';

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: overrides.ts ?? 0,
    phase: overrides.phase ?? 'researching',
    callId: overrides.callId ?? 'call-1',
    role: overrides.role ?? 'planner',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName ?? 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? 'activity-1',
    stage: overrides.stage ?? 'completed',
    kind: overrides.kind ?? 'read',
    label: overrides.label ?? 'reading file.ts',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
    ...(overrides.model !== undefined && { model: overrides.model }),
  };
}

function blockRows(
  events: EngineEventOf<'runner_call_activity'>[],
  options: { width?: number; expanded?: boolean; batchKey?: string } = {},
): ConversationRow[] {
  const width = options.width ?? 60;
  const model = buildActivityBatchViewModel({
    events,
    batchKey: options.batchKey ?? 'activity-batch',
    ...(options.expanded !== undefined && { expanded: options.expanded }),
  });
  const block = runnerActivityBatchRowBlock({ model, width });
  if (block === null) return [];
  return block.createRows(0, block.rowCount);
}

describe('runnerActivityBatchRowBlock tree markers', () => {
  it('marks activity header rows with the Claude Code bullet', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
    ]);

    const header = rows.find((rowValue) => rowValue.kind === 'activity');
    expect(header).toBeDefined();
    expect(header?.kind).toBe('activity');
  });

  it('marks activity-child rows with the Claude Code continuation marker', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
    ]);

    const middle = rows.filter((rowValue) => rowValue.kind === 'activity-child');
    const last = rows.filter((rowValue) => rowValue.kind === 'activity-child-last');
    expect(middle.length).toBeGreaterThan(0);
    expect(last.length).toBe(1);
  });

  it('keeps message and task rows free of continuation markers in row text', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
    ]);

    for (const rowValue of rows) {
      expect(rowValue.kind).not.toBe('message');
      expect(rowValue.kind).not.toBe('task-header');
    }
  });

  it('renders a pure-read batch flat without bordered card chrome', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
    ]);
    const text = rows.map(rowText).join('\n');

    expect(rows.every((rowValue) => rowValue.kind !== 'card-top')).toBe(true);
    expect(rows.every((rowValue) => rowValue.kind !== 'card-body')).toBe(true);
    expect(rows.every((rowValue) => rowValue.kind !== 'card-bottom')).toBe(true);
    expect(text).not.toContain('┌─');
    expect(text).not.toMatch(/─{3,}/);
    expect(text).toContain('READ  src/a.ts');
    expect(text).toContain('READ  src/b.ts');
    expect(text).toContain('READ  src/c.ts');
  });

  it('renders mixed read+edit batches flat with the same continuation marker', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'write', label: 'editing src/a.ts' }),
    ]);
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain('┌─');
    expect(text).toContain('READ  src/a.ts');
    expect(text).toContain('EDIT  src/a.ts');
    expect(
      rows.every(
        (rowValue) =>
          rowValue.kind === 'activity' ||
          rowValue.kind === 'activity-child' ||
          rowValue.kind === 'activity-child-last',
      ),
    ).toBe(true);
  });

  it('renders a lone activity as a self-contained bullet, not an orphan corner', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('activity');
    expect(rows.some((rowValue) => rowValue.kind === 'activity-child-last')).toBe(false);
    expect(rows.map(rowText).join('')).toContain('READ');
  });

  it('terminates the tree on the last real child and marks the +more affordance separately', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
      activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading src/d.ts' }),
    ]);

    const last = rows.filter((rowValue) => rowValue.kind === 'activity-child-last');
    const more = rows.filter((rowValue) => rowValue.kind === 'activity-more');
    const lastText = last.map(rowText).join('');
    const moreText = more.map(rowText).join('');
    expect(last).toHaveLength(1);
    expect(more).toHaveLength(1);
    expect(lastText).toContain('d.ts');
    expect(lastText).not.toContain('earlier');
    expect(moreText).toContain('earlier');
  });

  it('keeps the terminator on the last real child when expanded and marks less separately', () => {
    const rows = blockRows(
      [
        activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
        activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
        activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
        activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading src/d.ts' }),
      ],
      { expanded: true },
    );

    const last = rows.filter((rowValue) => rowValue.kind === 'activity-child-last');
    const more = rows.filter((rowValue) => rowValue.kind === 'activity-more');
    const lastText = last.map(rowText).join('');
    const moreText = more.map(rowText).join('');
    expect(last).toHaveLength(1);
    expect(more).toHaveLength(1);
    expect(lastText).toContain('d.ts');
    expect(moreText).toContain('less');
  });

  it('keeps every activity-child marker at the same cell width as the gutter', () => {
    for (const kind of ['activity-child', 'activity-child-last', 'activity-more'] as const) {
      expect(getTerminalCellWidth(rowMarker(kind) ?? '')).toBe(4);
    }
    expect(getTerminalCellWidth(rowMarker('activity') ?? '')).toBe(2);
  });
});
