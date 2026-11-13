import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections, type Section } from '../../../core/sections/event-sections.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { buildConversationRowsProjection } from './build.js';
import { buildConversationRowActions, findLatestConversationRowAction } from './row-actions.js';
import { rowText, segmentedRow } from './row-format/rows.js';
import { computeConversationRowScroll } from './scroll.js';
import type { ConversationRowBlock } from './types.js';

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
    // The row that names the key is the row the key toggles.
    expect(
      rows
        .filter((row) => row.kind === 'activity-more' && rowText(row).endsWith('ctrl+a'))
        .map((row) => actions.get(row.key)),
    ).toEqual([latestActivity]);
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

  it('gives the key to the lowest folded row while each folded row keeps its own action', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: ['a', 'b', 'c', 'd'].map((name, index) =>
          activity({
            callId: 'batch',
            sequence: index + 1,
            activityId: `batch-${name}`,
            kind: 'read',
            label: `reading ${name}.ts`,
          }),
        ),
      },
    ];
    const tailKey = 'closed-block:session';
    const tail: ConversationRowBlock[] = [
      {
        key: tailKey,
        rowCount: 3,
        renderableUnits: 0,
        foldRowKey: `${tailKey}-hidden`,
        createRows: () => [
          segmentedRow(`${tailKey}:outcome`, [{ text: 'Complete', tone: 'success' }], 'activity'),
          segmentedRow(
            `${tailKey}-hidden`,
            [{ text: '+4 more', tone: 'textDim' }],
            'activity-more',
          ),
          segmentedRow(
            `${tailKey}:session`,
            [{ text: 'Session', tone: 'text' }],
            'activity-child-last',
          ),
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
    const batch = { type: 'toggle-activity-batch', key: activityBatchKey(0, 'batch') } as const;
    const block = { type: 'toggle-activity-batch', key: tailKey } as const;

    const actions = buildConversationRowActions({ ...inputs, tail });
    const { rows } = computeConversationRowScroll({
      ...inputs,
      tail,
      rawScrollOffset: 0,
      renderableCountAtScroll: 0,
      heightAtScroll: 0,
    });

    expect(actions.get(`${batch.key}-hidden`)).toEqual(batch);
    expect(actions.get(`${tailKey}-hidden`)).toEqual(block);
    expect(actions.has(`${tailKey}:outcome`)).toBe(false);
    // The row that names the key is the row the key toggles.
    expect(
      rows
        .filter((row) => row.kind === 'activity-more' && rowText(row).endsWith('ctrl+a'))
        .map((row) => actions.get(row.key)),
    ).toEqual([findLatestConversationRowAction(actions, 'toggle-activity-batch')]);
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toEqual(block);
    expect(
      findLatestConversationRowAction(buildConversationRowActions(inputs), 'toggle-activity-batch'),
    ).toEqual(batch);
  });
});

describe('buildConversationRowActions check groups', () => {
  const check = (id: string): EngineEventOf<'full_suite'> => ({
    type: 'full_suite',
    ts: 0,
    phase: 'final-review',
    status: 'done',
    id,
    command: `npm test -- ${id}`,
    moment: 'pre-review',
    passed: true,
  });
  const checks = (count: number) =>
    Array.from({ length: count }, (_, index) => check(`V${index + 1}`));
  const reads = (callId: string) =>
    ['a', 'b', 'c', 'd'].map((name, index) =>
      activity({
        callId,
        phase: 'final-review',
        role: 'review',
        sequence: index + 1,
        activityId: `${callId}-${name}`,
        kind: 'read',
        label: `reading ${name}.ts`,
      }),
    );
  const inputsFor = (events: EngineEvent[]) => ({
    sections: groupEventsIntoSections(events),
    cols: 88,
    viewportHeight: 20,
    streaming,
    expandedDiffs: new Set<string>(),
    expandedActivityBatches: new Set<string>(),
  });
  const groupAction = (firstIndex: number) =>
    ({ type: 'toggle-activity-batch', key: `checks:${firstIndex}` }) as const;

  it('maps the fold row of a check group to the toggle of its fold key', () => {
    const inputs = inputsFor(checks(5));
    const actions = buildConversationRowActions(inputs);
    const foldRow = buildConversationRows(inputs).rows.find((row) => row.key === 'checks:0-hidden');

    expect(foldRow?.kind).toBe('activity-more');
    expect([...actions]).toEqual([['checks:0-hidden', groupAction(0)]]);
  });

  it('gives the key to an activity batch below a check group', () => {
    const actions = buildConversationRowActions(inputsFor([...checks(4), ...reads('review')]));

    expect(actions.get('checks:0-hidden')).toEqual(groupAction(0));
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toEqual({
      type: 'toggle-activity-batch',
      key: activityBatchKey(4, 'review'),
    });
  });

  it('gives the key to a check group below an activity batch', () => {
    const actions = buildConversationRowActions(inputsFor([...reads('review'), ...checks(4)]));

    expect(actions.get(`${activityBatchKey(0, 'review')}-hidden`)).toEqual({
      type: 'toggle-activity-batch',
      key: activityBatchKey(0, 'review'),
    });
    expect(findLatestConversationRowAction(actions, 'toggle-activity-batch')).toEqual(
      groupAction(4),
    );
  });

  it('maps nothing for a check group with no fold row', () => {
    const message: EngineEvent = {
      type: 'user_message',
      ts: 0,
      phase: 'final-review',
      text: 'Check this too.',
    };
    const inputs = inputsFor([...checks(4).map((event) => ({ ...event, passed: false })), message]);
    const group = buildConversationRowsProjection(inputs).blocks.find(
      (block) => block.key === 'checks:0',
    );

    expect(group?.rowCount).toBeGreaterThan(0);
    expect(group?.foldRowKey).toBeUndefined();
    expect(buildConversationRowActions(inputs).size).toBe(0);
  });
});

const longCause = `Runner failed ${'while applying the brief '.repeat(8)}raw-end`;
const quota = 'provider.quota: Insufficient Balance (request_id: spent-b2)';
const recoveryEvents: EngineEvent[] = [
  makeRunnerCallActivity({
    callId: 'spent-build',
    phase: 'implementing',
    taskId: taskId('T001'),
    runnerName: 'opencode',
    model: 'deepseek/deepseek-flash',
    kind: 'error',
    diagnosticPartial: quota,
  }),
  makeImplementerGenerate({
    status: 'failed',
    ts: 1,
    model: 'deepseek/deepseek-flash',
    error: quota,
  }),
  {
    type: 'recovery_prompted',
    ts: 2,
    phase: 'implementing',
    taskId: taskId('T001'),
    issueId: 'spent-b2',
    reason: 'runner-usage-limit',
    headline: 'Balance spent on OpenCode CLI',
    files: [],
    affectedTaskIds: [taskId('T001')],
    availableActions: ['switch-seat'],
    recommendedAction: 'switch-seat',
    resumeCommand: 'splitbrief continue',
  },
  {
    type: 'recovery_action_selected',
    ts: 3,
    phase: 'implementing',
    issueId: 'spent-b2',
    reason: 'runner-usage-limit',
    action: 'switch-seat',
    seat: 'build',
  },
  {
    type: 'seat_switched',
    ts: 4,
    phase: 'implementing',
    seat: 'build',
    from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    cause: 'runner-usage-limit',
    auto: true,
    configRevision: 'spent-b2',
  },
  {
    type: 'recovery_resolved',
    ts: 5,
    phase: 'implementing',
    issueId: 'spent-b2',
    reason: 'runner-usage-limit',
    action: 'switch-seat',
    seat: 'build',
    outcome: 'retry-current-task',
  },
];

describe('the latest diff toggle of the row model', () => {
  it.each<[string, Section<EngineEvent>[], string | null]>([
    [
      'a cut failure after a done diff, before a short failure',
      [
        {
          type: 'events',
          startIndex: 0,
          items: [
            makeImplementerGenerate({ status: 'done', diff: '+ earlier', ts: 0 }),
            makeImplementerGenerate({ status: 'failed', error: longCause, ts: 1 }),
            makeImplementerGenerate({ status: 'failed', error: 'Short cause', ts: 2 }),
          ],
        },
      ],
      'implementer_generate_failed:1',
    ],
    [
      'a Recovery row with diagnostics after a done diff',
      groupEventsIntoSections([
        makeImplementerGenerate({ status: 'done', diff: '+ earlier', ts: 0 }),
        ...recoveryEvents,
      ]),
      'recovery_prompted:3',
    ],
    [
      'a done diff of a settled brief before an empty diff',
      [
        {
          type: 'completed-task',
          startIndex: 0,
          summary: { id: 'T001', title: 'Done', method: 'local', retries: 0, duration: 1 },
          items: [makeImplementerGenerate({ status: 'done', diff: '+ settled', ts: 0 })],
        },
        {
          type: 'active-task',
          startIndex: 1,
          items: [makeImplementerGenerate({ status: 'done', diff: '', ts: 1 })],
        },
      ],
      'implementer_generate_done:0',
    ],
    [
      'no row that takes the toggle',
      [
        {
          type: 'events',
          startIndex: 0,
          items: [
            makeImplementerGenerate({ status: 'failed', error: 'Short cause', ts: 0 }),
            makeImplementerGenerate({ status: 'done', diff: '', ts: 1 }),
          ],
        },
      ],
      null,
    ],
  ])('is the key of the latest diff row action: %s', (_name, sections, expected) => {
    const inputs = {
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };

    expect(
      findLatestConversationRowAction(buildConversationRowActions(inputs), 'toggle-diff')?.key ??
        null,
    ).toBe(expected);
    expect(buildConversationRowsProjection(inputs).latestDiffKey).toBe(expected);
  });
});
