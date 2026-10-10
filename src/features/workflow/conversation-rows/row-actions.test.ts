import { describe, expect, it } from 'vitest';
import { diffEventKey, type Section } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
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
    kind: 'unknown',
    label: 'checking project',
    ...overrides,
  });
}

describe('buildConversationRowActions', () => {
  it.each([false, true])(
    'maps expandable drift rows through the existing expansion set, expanded=%s',
    (expanded) => {
      const event: EngineEventOf<'drift_report'> = {
        type: 'drift_report',
        ts: 0,
        phase: 'final-review',
        passed: false,
        errorCount: 3,
        warningCount: 2,
        findings: [
          { severity: 'warning', code: 'missing_expected_file', message: 'First warning.' },
          { severity: 'error', code: 'failed_task_with_diff', message: 'First error.' },
          { severity: 'info', code: 'out_of_scope_file', message: 'Hidden information.' },
          { severity: 'error', code: 'orphan_diff', message: 'Second error.' },
          { severity: 'warning', code: 'missing_evidence', message: 'Second warning.' },
          { severity: 'error', code: 'failed_task_with_diff', message: 'Third error.' },
        ],
      };
      const globalIndex = 8;
      const key = diffEventKey(event, globalIndex);
      const sections: Section<EngineEvent>[] = [
        { type: 'events', startIndex: globalIndex, items: [event] },
      ];
      const inputs = {
        sections,
        expandedDiffs: new Set(expanded ? [key] : []),
        expandedActivityBatches: new Set<string>(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      };
      const { rows } = buildConversationRows(inputs);
      const actions = buildConversationRowActions(inputs);

      expect(rows.map(rowText)).toEqual([
        'Drift · failed · 3 errors · 2 warnings',
        '  error · First error.',
        '  error · Second error.',
        '  error · Third error.',
        ...(expanded
          ? ['  warning · First warning.', '  warning · Second warning.']
          : ['  +2 more findings · click']),
      ]);
      expect(actions.size).toBe(rows.length);
      for (const row of rows) {
        expect(actions.get(row.key)).toEqual({ type: 'toggle-diff', key });
      }
    },
  );

  it.each([0, 1, 3])(
    'does not map drift with %i errors or warnings, regardless of information findings',
    (count) => {
      const event: EngineEventOf<'drift_report'> = {
        type: 'drift_report',
        ts: 0,
        phase: 'final-review',
        passed: true,
        errorCount: 0,
        warningCount: count,
        findings: [
          ...Array.from({ length: count }, (_, index) => ({
            severity: 'warning' as const,
            code: 'missing_expected_file' as const,
            message: `Warning ${index + 1}.`,
          })),
          { severity: 'info', code: 'out_of_scope_file', message: 'First information finding.' },
          { severity: 'info', code: 'out_of_scope_file', message: 'Second information finding.' },
          { severity: 'info', code: 'out_of_scope_file', message: 'Third information finding.' },
          { severity: 'info', code: 'out_of_scope_file', message: 'Fourth information finding.' },
        ],
      };
      const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 8, items: [event] }];

      expect(
        buildConversationRowActions({
          sections,
          expandedDiffs: new Set<string>(),
          expandedActivityBatches: new Set<string>(),
          cols: 88,
          viewportHeight: 20,
          streaming,
        }).size,
      ).toBe(0);
    },
  );

  it('does not map drift when recorded counts exceed the findings', () => {
    const event: EngineEventOf<'drift_report'> = {
      type: 'drift_report',
      ts: 0,
      phase: 'final-review',
      passed: false,
      errorCount: 4,
      warningCount: 0,
      findings: [
        { severity: 'error', code: 'failed_task_with_diff', message: 'First error.' },
        { severity: 'info', code: 'out_of_scope_file', message: 'Hidden information.' },
        { severity: 'error', code: 'orphan_diff', message: 'Second error.' },
      ],
    };
    const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 8, items: [event] }];

    expect(
      buildConversationRowActions({
        sections,
        expandedDiffs: new Set<string>(),
        expandedActivityBatches: new Set<string>(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      }).size,
    ).toBe(0);
  });

  it('does not map a legacy drift event without findings', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          {
            type: 'drift_report',
            ts: 0,
            phase: 'final-review',
            passed: false,
            errorCount: 4,
            warningCount: 0,
          },
        ],
      },
    ];

    expect(
      buildConversationRowActions({
        sections,
        expandedDiffs: new Set<string>(),
        expandedActivityBatches: new Set<string>(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      }).size,
    ).toBe(0);
  });

  it('maps the rendered +N more row to a toggle-activity-batch action', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
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

    const { rows } = buildConversationRows(inputs);
    const moreRow = rows.find((row) => row.kind === 'activity-more');
    if (!moreRow) throw new Error('expected a +N more disclosure row');

    const actions = buildConversationRowActions(inputs);
    expect(actions.get(moreRow.key)).toEqual({
      type: 'toggle-activity-batch',
      key: activityBatchKey(0, 'call-1'),
    });
  });

  it('maps the rendered diff rows to a toggle-diff action keyed by global render index', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ x', ts: 5 })],
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

    const { rows } = buildConversationRows(inputs);
    const actions = buildConversationRowActions(inputs);
    const actionableRows = rows.filter((row) => actions.has(row.key));

    expect(actionableRows.length).toBeGreaterThan(0);
    for (const row of actionableRows) {
      expect(actions.get(row.key)).toEqual({
        type: 'toggle-diff',
        key: 'implementer_generate_done:0',
      });
    }
  });

  it('maps the cut implementer-failure rows to a toggle-diff action', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          {
            type: 'implementer_generate_failed',
            ts: 0,
            phase: 'implementing',
            taskId: taskId('T010'),
            model: 'opencode-go/deepseek-v4.1-flash',
            error:
              'Tool implementer (opencode) exited without changing any files after a completed call that reported done for every file in its brief',
          },
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

    const { rows } = buildConversationRows(inputs);
    const actions = buildConversationRowActions(inputs);
    const actionableRows = rows.filter((row) => actions.has(row.key));

    expect(actionableRows.length).toBeGreaterThan(0);
    for (const row of actionableRows) {
      expect(actions.get(row.key)).toEqual({
        type: 'toggle-diff',
        key: 'implementer_generate_failed:0',
      });
    }
  });

  it('leaves an implementer failure whose cause fits without an action', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          {
            type: 'implementer_generate_failed',
            ts: 0,
            phase: 'implementing',
            taskId: taskId('T010'),
            model: 'opencode-go/deepseek-v4.1-flash',
            error: 'Edit bundle did not apply',
          },
        ],
      },
    ];

    const actions = buildConversationRowActions({
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    expect(actions.size).toBe(0);
  });

  it('does not map a non-expandable activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' })],
      },
    ];
    const actions = buildConversationRowActions({
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    expect(actions.size).toBe(0);
  });
});
