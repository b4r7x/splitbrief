import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import { colorForTone } from '../display/tone-color.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { rowText } from './row-format/rows.js';
import type { ConversationRow } from './types.js';

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  ${value}`;
}

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
  it('colors the activity header label by its batch role hue', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading src/b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading src/c.ts' }),
    ]);
    const header = rows.find((rowValue) => rowValue.kind === 'activity');
    const theme = getTheme();

    expect(header?.segments[0]?.tone).toBe('planner');
    expect(colorForTone(header?.segments[0]?.tone, theme)).toBe(theme.planner);
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
    expect(text).toContain(activityLine('READ', 'src/a.ts'));
    expect(text).toContain(activityLine('READ', 'src/b.ts'));
    expect(text).toContain(activityLine('READ', 'src/c.ts'));
  });

  it('renders mixed read+edit batches flat with the same continuation marker', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'write', label: 'editing src/a.ts' }),
    ]);
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain('┌─');
    expect(text).toContain(activityLine('READ', 'src/a.ts'));
    expect(text).toContain(activityLine('EDIT', 'src/a.ts'));
    expect(
      rows.every(
        (rowValue) =>
          rowValue.kind === 'activity' ||
          rowValue.kind === 'activity-child' ||
          rowValue.kind === 'activity-child-last',
      ),
    ).toBe(true);
  });

  it('renders a lone activity under its always-on header, never as a bare item row', () => {
    const rows = blockRows([
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading src/a.ts' }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('activity');
    expect(rows[0] ? rowText(rows[0]) : '').toContain('1 update');
    expect(rows[1]?.kind).toBe('activity-child-last');
    expect(rows.map(rowText).join('')).toContain('Read');
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
    expect(lastText).not.toContain('more');
    expect(moreText).toContain('more');
  });

  it('terminates the expanded batch on the last real child and marks a collapse disclosure', () => {
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
    expect(moreText).toContain('collapse');
    expect(moreText).not.toContain('more');
  });
});

describe('event row color-off legibility', () => {
  const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
  const ctx = { width: 80, viewportRows: 20, streaming } as const;

  it('distinguishes brief-quality pass from fail with a word, not color alone', () => {
    const passed = eventRows({
      event: {
        type: 'brief_quality_passed',
        ts: 0,
        phase: 'planning',
        score: 0.95,
        warningCount: 0,
      },
      globalIndex: 0,
      expanded: false,
      ctx,
    });
    const failed = eventRows({
      event: {
        type: 'brief_quality_failed',
        ts: 0,
        phase: 'planning',
        score: 0.5,
        errorCount: 0,
        warningCount: 0,
      },
      globalIndex: 1,
      expanded: false,
      ctx,
    });

    expect(passed.map(rowText).join(' ')).toContain('passed');
    expect(failed.map(rowText).join(' ')).toContain('failed');
  });

  it('marks a failed validation run with the word failed even with color off', () => {
    const failed = eventRows({
      event: {
        type: 'validate',
        ts: 0,
        phase: 'validating-task',
        taskId: taskId('T001'),
        status: 'done',
        passed: false,
        stages: { typecheck: false, lint: false, test: false },
        error: 'typecheck failed',
      },
      globalIndex: 0,
      expanded: false,
      ctx,
    });

    expect(failed.map(rowText).join(' ')).toContain('failed');
  });
});
