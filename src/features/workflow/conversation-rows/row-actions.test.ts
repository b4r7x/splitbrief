import { describe, expect, it } from 'vitest';
import { diffEventKey, type Section } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { buildConversationRowsProjection } from './build.js';
import { buildConversationRowActions, findLatestConversationRowAction } from './row-actions.js';
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

  it('keeps older disclosures clickable and maps every eligible batch', () => {
    const batch = (callId: string) =>
      ['a', 'b', 'c', 'd'].map((name, index) =>
        activity({
          callId,
          sequence: index + 1,
          activityId: `${callId}-${name}`,
          kind: 'read',
          label: `reading ${name}.ts`,
        }),
      );
    const sections: Section<EngineEvent>[] = [
      {
        type: 'completed-task',
        startIndex: 0,
        summary: { id: 'T001', title: 'Done', method: 'local', retries: 0, duration: 1 },
        items: [
          ...batch('older'),
          makeImplementerGenerate({ diff: '+ retained diff' }),
          makeImplementerGenerate({ status: 'failed', error: 'Failure evidence '.repeat(30) }),
        ],
      },
      {
        type: 'settled-stage',
        startIndex: 6,
        summary: { stage: 'plan', feature: 'Plan', duration: 1 },
        items: batch('latest'),
      },
      {
        type: 'events',
        startIndex: 10,
        items: [
          activity({
            callId: 'small',
            activityId: 'small',
            kind: 'read',
            label: 'reading tail.ts',
          }),
        ],
      },
    ];
    const inputs = {
      sections,
      cols: 88,
      viewportHeight: 20,
      streaming,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
    };
    const { rows } = buildConversationRows(inputs);
    const actions = buildConversationRowActions(inputs);
    expect(
      rows.filter((row) => row.kind === 'activity-more').map((row) => actions.get(row.key)),
    ).toEqual([
      { type: 'toggle-activity-batch', key: activityBatchKey(0, 'older') },
      { type: 'toggle-activity-batch', key: activityBatchKey(6, 'latest') },
    ]);
    expect([...actions.values()]).toContainEqual({
      type: 'toggle-diff',
      key: 'implementer_generate_done:4',
    });
    expect([...actions.values()]).toContainEqual({
      type: 'toggle-diff',
      key: 'implementer_generate_failed:5',
    });
    const diff = { type: 'toggle-diff', key: 'implementer_generate_failed:5' } as const;
    const latestActivity = {
      type: 'toggle-activity-batch',
      key: activityBatchKey(6, 'latest'),
    } as const;
    expect(findLatestConversationRowAction(actions, 'toggle-diff')).toEqual(diff);
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toEqual(
      latestActivity,
    );
    const expanded = buildConversationRowActions({
      ...inputs,
      expandedDiffs: new Set([diff.key]),
      expandedActivityBatches: new Set([latestActivity.key]),
    });
    expect(findLatestConversationRowAction(expanded, 'toggle-diff')).toEqual(diff);
    expect(findLatestConversationRowAction(expanded, 'toggle-activity-batch')).toEqual(
      latestActivity,
    );
    for (const row of rows.filter((row) => row.node !== undefined))
      expect(actions.has(row.key)).toBe(false);
    const blocks = buildConversationRowsProjection(inputs).blocks;
    expect(
      blocks.find((block) => block.key === activityBatchKey(0, 'older'))?.activeRowKey,
    ).toBeUndefined();
    expect(
      blocks.find((block) => block.key === activityBatchKey(6, 'latest'))?.activeRowKey,
    ).toBeUndefined();
    expect(
      blocks.find((block) => block.key === activityBatchKey(10, 'small'))?.activeRowKey,
    ).toBeDefined();
  });
  it('selects the latest retained diff across settled sections with same-timestamp events', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'active-task',
        startIndex: 0,
        items: [makeImplementerGenerate({ status: 'done', diff: '+ older', ts: 42 })],
      },
      {
        type: 'settled-stage',
        startIndex: 1,
        items: [
          makeImplementerGenerate({ status: 'done', diff: '+ latest', ts: 42 }),
          makeImplementerGenerate({ status: 'done', diff: '', ts: 42 }),
          makeImplementerGenerate({ status: 'failed', error: 'Short cause', ts: 42 }),
        ],
        summary: { stage: 'plan', feature: 'Settled plan', duration: 0 },
      },
    ];
    const actions = buildConversationRowActions({
      sections,
      cols: 88,
      viewportHeight: 20,
      streaming,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
    });

    expect(findLatestConversationRowAction(actions, 'toggle-diff')).toEqual({
      type: 'toggle-diff',
      key: 'implementer_generate_done:1',
    });
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toBeNull();
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
    expect(findLatestConversationRowAction(actions, 'toggle-diff')).toBeNull();
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toBeNull();
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
