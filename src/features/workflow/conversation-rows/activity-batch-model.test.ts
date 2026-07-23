import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
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
  it('keeps collapsed rows bounded while summarizing latest deduped severity', () => {
    const model = buildActivityBatchViewModel({
      batchKey: 'batch-1',
      events: [
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
      ],
    });

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
    expect(model.visibleItems.map((item) => item.pinned)).toEqual([false, false, false]);
    expect(
      model.visibleItems.map((item) => ({
        value: item.value,
        severity: item.severity,
        pinned: item.pinned,
      })),
    ).toContainEqual({ value: 'npm test', severity: 'info', pinned: false });
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
  });
});

describe('activity batch tone resolution', () => {
  const theme = getTheme();
  const roles = [
    'planner',
    'implementer',
    'review',
    'summary',
    'compaction',
    'escalation',
  ] as const satisfies readonly NonNullable<EngineEventOf<'runner_call_activity'>['role']>[];

  it('resolves work roles to their own hue and ancillary roles to dim', () => {
    const expected: Record<(typeof roles)[number], string> = {
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
