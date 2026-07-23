import { describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makePlannerHeartbeat, makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeTaskTokens } from '#testing/helpers/events/task.js';
import { activityBatchKey, findLatestExpandableActivityBatchKey } from './activity-batch-key.js';
import { buildConversationRows } from './build.js';
import { buildConversationRowActions } from './row-actions.js';
import { rowText } from './row-format/rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity({
    ts: 0,
    phase: 'researching',
    role: 'planner',
    runnerName: 'codex',
    sequence: 1,
    activityId: 'activity-1',
    stage: 'updated',
    kind: 'read',
    label: 'reading file.ts',
    ...overrides,
  });
}

describe('activityBatchKey', () => {
  it('uses the first row index and call id as the stable activity batch identity', () => {
    expect(activityBatchKey(7, 'call-1')).toBe('activity-batch:7:call-1');
  });
});

describe('findLatestExpandableActivityBatchKey', () => {
  it('returns the latest batch with hidden activity rows', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ callId: 'call-1', sequence: 1, activityId: 'a', label: 'reading a.ts' }),
          activity({ callId: 'call-1', sequence: 2, activityId: 'b', label: 'reading b.ts' }),
          activity({ callId: 'call-1', sequence: 3, activityId: 'c', label: 'reading c.ts' }),
          activity({ callId: 'call-1', sequence: 4, activityId: 'd', label: 'reading d.ts' }),
          activity({ callId: 'call-2', sequence: 1, activityId: 'e', label: 'reading e.ts' }),
          activity({ callId: 'call-2', sequence: 2, activityId: 'f', label: 'reading f.ts' }),
        ],
      },
      {
        type: 'events',
        startIndex: 6,
        items: [
          activity({ callId: 'call-3', sequence: 1, activityId: 'g', label: 'reading g.ts' }),
          activity({ callId: 'call-3', sequence: 2, activityId: 'h', label: 'reading h.ts' }),
          activity({ callId: 'call-3', sequence: 3, activityId: 'i', label: 'reading i.ts' }),
          activity({ callId: 'call-3', sequence: 4, activityId: 'j', label: 'reading j.ts' }),
        ],
      },
    ];

    expect(findLatestExpandableActivityBatchKey(sections)).toBe(activityBatchKey(6, 'call-3'));
  });

  it('ignores batches with three or fewer distinct activity rows', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ callId: 'call-1', sequence: 1, activityId: 'a', label: 'reading a.ts' }),
          activity({ callId: 'call-1', sequence: 2, activityId: 'b', label: 'reading b.ts' }),
          activity({ callId: 'call-1', sequence: 3, activityId: 'c', label: 'reading c.ts' }),
        ],
      },
    ];

    expect(findLatestExpandableActivityBatchKey(sections)).toBeNull();
  });

  it('ignores duplicate raw events that normalize to the same visible activity row', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'run-start',
            kind: 'command',
            label: 'running /bin/zsh -lc "npm run typecheck"',
            target: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 2,
            activityId: 'run-done',
            kind: 'command',
            label: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 3,
            activityId: 'run-repeat',
            kind: 'command',
            label: 'running npm run typecheck',
            target: 'npm run typecheck',
          }),
          activity({
            sequence: 4,
            activityId: 'read',
            kind: 'read',
            label: 'reading src/app.ts',
          }),
          activity({
            sequence: 5,
            activityId: 'search',
            kind: 'search',
            label: 'searching updateOperations',
          }),
        ],
      },
    ];

    expect(findLatestExpandableActivityBatchKey(sections)).toBeNull();
  });

  it('counts distinct warning diagnostics the same way the activity renderer does', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'a',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'warning a',
          }),
          activity({
            sequence: 2,
            activityId: 'b',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'warning b',
          }),
          activity({
            sequence: 3,
            activityId: 'c',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'warning c',
          }),
          activity({
            sequence: 4,
            activityId: 'd',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'warning d',
          }),
        ],
      },
    ];

    expect(findLatestExpandableActivityBatchKey(sections)).toBe(activityBatchKey(0, 'call-1'));
  });

  it('rows, row actions, and batch keys agree on batch boundaries', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          { type: 'planner_text', ts: 0, phase: 'researching', text: 'Kicking off.' },
          activity({ callId: 'call-1', sequence: 1, activityId: 'a', label: 'reading a.ts' }),
          makePlannerHeartbeat({ ts: 1 }),
          activity({ callId: 'call-1', sequence: 2, activityId: 'b', label: 'reading b.ts' }),
          makePlannerStatus({ ts: 2, phase: 'researching' }),
          activity({ callId: 'call-1', sequence: 3, activityId: 'c', label: 'reading c.ts' }),
          makeTaskTokens({ ts: 3 }),
          activity({ callId: 'call-1', sequence: 4, activityId: 'd', label: 'reading d.ts' }),
          activity({ callId: 'call-2', sequence: 1, activityId: 'e', label: 'reading e.ts' }),
          makePlannerHeartbeat({ ts: 4, elapsedMs: 900, accumulatedTokens: 9 }),
          activity({ callId: 'call-2', sequence: 2, activityId: 'f', label: 'reading f.ts' }),
          activity({ callId: 'call-2', sequence: 3, activityId: 'g', label: 'reading g.ts' }),
          activity({ callId: 'call-2', sequence: 4, activityId: 'h', label: 'reading h.ts' }),
        ],
      },
    ];
    const inputs = {
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };
    const firstBatchKey = activityBatchKey(1, 'call-1');
    const latestBatchKey = activityBatchKey(8, 'call-2');

    expect(findLatestExpandableActivityBatchKey(sections)).toBe(latestBatchKey);

    const { rows } = buildConversationRows(inputs);
    const moreRows = rows.filter((row) => row.kind === 'activity-more');
    expect(moreRows).toHaveLength(2);

    const actions = buildConversationRowActions(inputs);
    expect(moreRows.map((row) => actions.get(row.key))).toEqual([
      { type: 'toggle-activity-batch', key: firstBatchKey },
      { type: 'toggle-activity-batch', key: latestBatchKey },
    ]);

    const expanded = buildConversationRows({
      ...inputs,
      expandedActivityBatches: new Set([latestBatchKey]),
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('e.ts');
    expect(expandedText).not.toContain('a.ts');
  });
});
