import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../../../components/theme.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { colorForTone } from '../display/tone-color.js';
import {
  activityBatchTone,
  buildActivityBatchViewModel,
  COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT,
  toneToConversationTone,
} from './activity-batch-model.js';

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
    stage: overrides.stage ?? 'updated',
    kind: overrides.kind ?? 'unknown',
    label: overrides.label ?? 'checking project',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
    ...(overrides.model !== undefined && { model: overrides.model }),
    ...(overrides.taskId !== undefined && { taskId: overrides.taskId }),
    ...(overrides.attempt !== undefined && { attempt: overrides.attempt }),
    ...(overrides.textPartial !== undefined && { textPartial: overrides.textPartial }),
    ...(overrides.diagnosticPartial !== undefined && {
      diagnosticPartial: overrides.diagnosticPartial,
    }),
    ...(overrides.rawAvailable !== undefined && { rawAvailable: overrides.rawAvailable }),
  };
}

describe('buildActivityBatchViewModel', () => {
  it('omits historical session activity from rows, counts and disclosure', () => {
    const session = activity({ kind: 'session', label: 'session captured' });
    const read = activity({ kind: 'read', label: 'reading docs/TESTING.md' });
    for (const expanded of [false, true]) {
      const model = buildActivityBatchViewModel({
        batchKey: 'old-call',
        events: [session, read],
        expanded,
      });
      expect(model.headerCount).toBe(1);
      expect(model.headerText).toContain('1 update');
      expect(model.visibleItems.map((item) => item.value)).toEqual(['docs/TESTING.md']);
      expect(model.renderableUnits).toBe(1);
      expect(model.hiddenCount).toBe(0);

      const onlySession = buildActivityBatchViewModel({
        batchKey: 'old-call',
        events: [session],
        expanded,
      });
      expect(onlySession.headerText).toBeNull();
      expect(onlySession.visibleItems).toEqual([]);
      expect(onlySession.renderableUnits).toBe(0);
    }
  });

  it('keeps collapsed rows bounded while summarizing latest deduped severity', () => {
    const events = [
      activity({
        sequence: 1,
        activityId: 'command-start',
        kind: 'command',
        stage: 'updated',
        label: 'running npm test',
        target: 'npm test',
      }),
      activity({
        sequence: 2,
        activityId: 'a',
        kind: 'read',
        label: 'reading a.ts',
        rawAvailable: true,
      }),
      activity({ sequence: 3, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
      activity({ sequence: 4, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
      activity({ sequence: 5, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
      activity({
        sequence: 6,
        activityId: 'command-failed',
        kind: 'command',
        stage: 'failed',
        label: 'failed npm test',
        target: 'npm test',
      }),
    ];
    const model = buildActivityBatchViewModel({ batchKey: 'batch-1', events });

    expect(model.visibleItems).toHaveLength(COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
    expect(model.headerCount).toBe(5);
    expect(model.hiddenCount).toBe(2);
    expect(model.severityCounts).toEqual({ info: 4, warning: 0, error: 1 });
    expect(model.groups).toEqual([
      { label: 'run', count: 1 },
      { label: 'read', count: 4 },
    ]);
    expect(model.rawMarkers).toBe(1);
    expect(model.headerText).toContain('5 updates');
    expect(model.headerText).toContain('1 err');
    expect(model.visibleItems.map((item) => item.value)).toContain('npm test');
    expect(model.visibleItems.map((item) => item.value)).not.toContain('a.ts');
    expect(model.visibleItems.map((item) => item.value)).toEqual(['c.ts', 'd.ts', 'npm test']);
    const expanded = buildActivityBatchViewModel({ batchKey: 'batch-1', events, expanded: true });
    expect(expanded.visibleItems.map((item) => item.value)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
      'npm test',
    ]);
  });

  it('clears a collapsed pin when the latest deduped item de-escalates', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [
        activity({
          sequence: 1,
          activityId: 'stage-warning',
          kind: 'command',
          stage: 'warning',
          label: 'running npm test',
          target: 'npm test',
        }),
        activity({ sequence: 2, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
        activity({ sequence: 3, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
        activity({ sequence: 4, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
        activity({
          sequence: 5,
          activityId: 'stage-completed',
          kind: 'command',
          stage: 'completed',
          label: 'completed npm test',
          target: 'npm test',
        }),
      ],
    });

    expect(model.headerCount).toBe(4);
    expect(model.severityCounts).toEqual({ info: 4, warning: 0, error: 0 });
    expect(model.headerText).toContain('4 updates');
    expect(model.headerText).not.toContain('warn');
    expect(model.visibleItems).toHaveLength(COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
    expect(model.visibleItems.map((item) => item.severity)).toEqual(['info', 'info', 'info']);
    expect(model.visibleItems.map((item) => item.value)).toEqual(['b.ts', 'c.ts', 'npm test']);
  });

  it('materializes all deduped rows only when expanded', () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      activity({
        sequence: index + 1,
        activityId: `read-${index}`,
        kind: 'read',
        label: `reading file-${index}.ts`,
      }),
    );

    const collapsed = buildActivityBatchViewModel({ batchKey: 'batch-1', events });
    const expanded = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events,
      expanded: true,
    });

    expect(collapsed.visibleItems).toHaveLength(COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT);
    expect(expanded.visibleItems).toHaveLength(50);
    expect(collapsed.headerCount).toBe(50);
    expect(expanded.headerCount).toBe(50);
    expect(collapsed.visibleItems.map((item) => item.value)).toEqual(
      expanded.visibleItems.slice(-COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT).map((item) => item.value),
    );
  });

  it('shows the newest entries in event order and pins no earlier warning', () => {
    const oldestWarning = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [
        activity({ sequence: 1, activityId: 'warning', kind: 'warning', label: 'warning stderr' }),
        activity({ sequence: 2, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
        activity({ sequence: 3, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
        activity({ sequence: 4, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
        activity({ sequence: 5, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
      ],
    });

    expect(oldestWarning.visibleItems.map((item) => item.value)).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(oldestWarning.headerText).toContain('1 warn');

    const newestWarningEvents = [
      activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
      activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
      activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
      activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
      activity({ sequence: 5, activityId: 'warning', kind: 'warning', label: 'warning stderr' }),
    ];
    const newestWarning = buildActivityBatchViewModel({
      batchKey: 'batch-2',
      events: newestWarningEvents,
    });
    const newestWarningExpanded = buildActivityBatchViewModel({
      batchKey: 'batch-2',
      events: newestWarningEvents,
      expanded: true,
    });

    expect(newestWarning.visibleItems.map((item) => item.value)).toEqual([
      'c.ts',
      'd.ts',
      'stderr',
    ]);
    expect(newestWarningExpanded.visibleItems.map((item) => item.value)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
      'stderr',
    ]);
  });
});

describe('activity batch tone resolution', () => {
  const theme = defaultTheme;
  const roles = [
    'planner',
    'implementer',
    'review',
    'summary',
    'compaction',
    'escalation',
  ] as const satisfies readonly NonNullable<EngineEventOf<'runner_call_activity'>['role']>[];

  it('resolves work roles to their own hue and ancillary roles to dim', () => {
    const expected: Record<(typeof roles)[number], string | undefined> = {
      planner: theme.planner,
      implementer: theme.implementer,
      review: theme.validator,
      summary: theme.textDim,
      compaction: theme.textDim,
      escalation: theme.textDim,
    };
    for (const role of roles) {
      const tone = activityBatchTone([activity({ role })]);
      expect(colorForTone(tone, theme)).toBe(expected[role]);
    }
  });

  it('paints a review call with the review-stage hue in every phase', () => {
    for (const phase of ['final-review', 'analyzing'] as const) {
      const tone = activityBatchTone([activity({ role: 'review', phase })]);
      expect(colorForTone(tone, theme)).toBe(theme.validator);
    }
  });

  it('resolves a role-less batch to the neutral dim tone', () => {
    const tone = activityBatchTone([]);
    expect(tone).toBe('textDim');
    expect(colorForTone(tone, theme)).toBe(theme.textDim);
  });

  it('maps each ledger tone onto its own rendered hue without flattening severity', () => {
    expect(toneToConversationTone('success')).toBe('success');
    expect(toneToConversationTone('error')).toBe('error');
    expect(toneToConversationTone('warning')).toBe('warning');
    expect(toneToConversationTone('info')).toBe('info');
    expect(toneToConversationTone('textDim')).toBe('textDim');

    expect(colorForTone(toneToConversationTone('success'), theme)).toBe(theme.success);
    expect(colorForTone(toneToConversationTone('error'), theme)).toBe(theme.error);
    expect(colorForTone(toneToConversationTone('warning'), theme)).toBe(theme.warning);
    expect(colorForTone(toneToConversationTone('info'), theme)).toBe(theme.info);
  });
});

describe('activity batch runner identity', () => {
  it('names a custom API call by its own provider word and the pretty model name', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [activity({ backendKind: 'api', runnerName: 'opencode', model: 'gpt-5' })],
    });

    expect(model.headerRunner).toBe('opencode · GPT-5');
  });

  it('names a CLI call by its catalog display name', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [activity({ backendKind: 'cli', runnerName: 'opencode', model: 'gpt-5' })],
    });

    expect(model.headerRunner).toBe('OpenCode CLI · GPT-5');
  });

  it('names a CLI call recorded by its command through the tool it starts', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [activity({ backendKind: 'cli', runnerName: 'claude', model: 'sonnet' })],
    });

    expect(model.headerRunner).toBe('Claude Code CLI · Sonnet 5');
  });

  it('spells an API call model pretty when its name is a CLI alias, never with the CLI label', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [activity({ backendKind: 'api', runnerName: 'claude-code', model: 'sonnet' })],
    });

    // The API twin named after the CLI tool must not borrow the CLI alias's display name.
    expect(model.headerRunner).toBe('claude-code · Sonnet');
  });

  it('names a shell call by its own runner word and the pretty model name', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [activity({ backendKind: 'shell', runnerName: 'opencode', model: 'gpt-5' })],
    });

    expect(model.headerRunner).toBe('opencode · GPT-5');
  });
});
