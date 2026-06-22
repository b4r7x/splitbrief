import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../engine/events/types.js';
import { addEvent, resetWorkflow } from './actions.js';
import { activityStore } from './activity.js';

type RunnerToolUseDeltaEvent = Extract<EngineEventOf<'runner_call_tool_use'>, { stage: 'delta' }>;

function toolUse(
  overrides?: Partial<RunnerToolUseDeltaEvent>,
): EngineEventOf<'runner_call_tool_use'> {
  const event: RunnerToolUseDeltaEvent = {
    ...overrides,
    type: 'runner_call_tool_use',
    ts: overrides?.ts ?? 1_000,
    phase: overrides?.phase ?? 'implementing',
    callId: overrides?.callId ?? 'call-1',
    role: overrides?.role ?? 'implementer',
    backendKind: overrides?.backendKind ?? 'cli',
    runnerName: overrides?.runnerName ?? 'codex',
    sequence: overrides?.sequence ?? 1,
    stage: overrides?.stage ?? 'delta',
    name: overrides?.name ?? 'Bash',
    inputDelta: overrides?.inputDelta ?? '{"command":"npm run typecheck"}',
  };
  return event;
}

function activity(
  overrides?: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: overrides?.ts ?? 1_000,
    phase: overrides?.phase ?? 'implementing',
    callId: overrides?.callId ?? 'call-1',
    role: overrides?.role ?? 'implementer',
    backendKind: overrides?.backendKind ?? 'cli',
    runnerName: overrides?.runnerName ?? 'codex',
    sequence: overrides?.sequence ?? 1,
    activityId: overrides?.activityId ?? 'call-1:tool:Bash',
    stage: overrides?.stage ?? 'updated',
    kind: overrides?.kind ?? 'command',
    label: overrides?.label ?? 'running npm run typecheck',
    redacted: overrides?.redacted ?? false,
    ...overrides,
  };
}

describe('activityStore', () => {
  beforeEach(() => resetWorkflow());

  it('uses safe activity events and ignores raw runner content events', () => {
    addEvent(toolUse());
    addEvent(activity({ label: 'checking repo', activityId: 'call-1:system', kind: 'unknown' }));
    addEvent(activity({ sequence: 2, label: 'running npm run typecheck' }));
    addEvent(
      activity({
        sequence: 3,
        activityId: 'call-1:session',
        stage: 'completed',
        kind: 'session',
        label: 'session native-session-1',
        target: 'native-session-1',
        rawAvailable: true,
        expandId: 'native-session-1',
      }),
    );

    expect(activityStore.get().items.map((item) => item.label)).toEqual([
      'checking repo',
      'running npm run typecheck',
      'session captured',
    ]);
    expect(JSON.stringify(activityStore.get().items)).not.toContain('native-session-1');
  });

  it('replaces repeated event identity and keeps the latest bounded history', () => {
    addEvent(activity({ activityId: 'activity-1', callId: 'call-1', label: 'one' }));
    addEvent(activity({ activityId: 'activity-1', callId: 'call-1', label: 'one updated' }));
    addEvent(activity({ activityId: 'activity-2', callId: 'call-2', label: 'two' }));

    expect(activityStore.get().items).toHaveLength(2);

    for (let index = 0; index < 12; index += 1) {
      addEvent(
        activity({
          ts: 2_000 + index,
          sequence: 10 + index,
          callId: `call-${index + 10}`,
          activityId: `activity-${index + 10}`,
          label: `running cmd-${index}`,
        }),
      );
    }

    const labels = activityStore.get().items.map((item) => item.label);
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe('running cmd-4');
    expect(labels.at(-1)).toBe('running cmd-11');
  });

  it('coalesces repeated warning activity by stable identity', () => {
    addEvent(
      activity({
        activityId: 'call-1:warning:stable',
        kind: 'warning',
        stage: 'warning',
        label: 'warning stderr',
        diagnosticPartial: 'same warning',
      }),
    );
    addEvent(
      activity({
        ts: 1_100,
        sequence: 2,
        activityId: 'call-1:warning:stable',
        kind: 'warning',
        stage: 'warning',
        label: 'warning stderr',
        diagnosticPartial: 'same warning',
      }),
    );

    expect(activityStore.get().items).toHaveLength(1);
    expect(activityStore.get().items[0]).toMatchObject({
      id: 'call-1:warning:stable',
      sequence: 2,
      diagnosticPartial: 'same warning',
    });
  });

  it('sanitizes activity display fields before storing them', () => {
    addEvent(
      activity({
        label:
          '\u001b]8;;https://evil.example\u0007running sk-abcdefghijklmnopqrstuvwxyz\u001b]8;;\u0007',
        target: 'token=sk-abcdefghijklmnopqrstuvwxyz',
        diagnosticPartial: 'failed with sk-abcdefghijklmnopqrstuvwxyz',
      }),
    );

    const serialized = JSON.stringify(activityStore.get().items);
    expect(serialized).toContain('sk-***REDACTED***');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('\u001b]8');
    expect(activityStore.get().items[0]?.redacted).toBe(true);
  });

  it('retires running activity when a runner call completes or fails', () => {
    addEvent(activity({ callId: 'call-1', activityId: 'call-1:tool:Bash', stage: 'updated' }));
    addEvent(
      activity({
        callId: 'call-1',
        activityId: 'call-1:tool:Read',
        stage: 'completed',
        kind: 'read',
        label: 'reading src/app.ts',
      }),
    );
    addEvent({
      type: 'runner_call_completed',
      ts: 2_000,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 10,
      status: 'completed',
      error: null,
      startedAt: 1_000,
      endedAt: 2_000,
      durationMs: 1_000,
      partial: false,
      usage: null,
      nativeSessionId: null,
    });

    expect(activityStore.get().items.map((item) => item.label)).toEqual(['reading src/app.ts']);
  });

  it('stores terminal activity view-model fields for side-rail and expand consumers', () => {
    addEvent(
      activity({
        callId: 'call-1',
        activityId: 'call-1:terminal',
        stage: 'timeout',
        kind: 'error',
        label: 'timeout timeout',
        target: 'runner timed out',
        redacted: true,
        rawAvailable: true,
        expandId: 'call-1:terminal',
        textPartial: 'partial output',
        diagnosticPartial: 'runner timed out',
      }),
    );

    expect(activityStore.get().items[0]).toMatchObject({
      id: 'call-1:terminal',
      callId: 'call-1',
      stage: 'timeout',
      kind: 'error',
      label: 'timeout timeout',
      target: 'runner timed out',
      redacted: true,
      rawAvailable: true,
      expandId: 'call-1:terminal',
      textPartial: 'partial output',
      diagnosticPartial: 'runner timed out',
      sequence: 1,
    });
  });

  it('does not synthesize expand metadata when raw activity is unavailable', () => {
    addEvent(
      activity({
        activityId: 'call-1:warning',
        kind: 'warning',
        stage: 'warning',
        label: 'warning stderr',
        rawAvailable: false,
      }),
    );

    expect(activityStore.get().items[0]).toMatchObject({
      id: 'call-1:warning',
      rawAvailable: false,
    });
    expect(activityStore.get().items[0]).not.toHaveProperty('expandId');
  });

  it('clears activity on workflow cancellation', () => {
    addEvent(activity());
    addEvent({ type: 'workflow_cancelled', ts: 2_000, phase: 'implementing' });

    expect(activityStore.get().items).toEqual([]);
  });

  it('does not re-add late activity after cancellation', () => {
    addEvent(activity());
    addEvent({ type: 'workflow_cancelled', ts: 2_000, phase: 'implementing' });
    addEvent(
      activity({
        ts: 2_100,
        stage: 'completed',
        activityId: 'call-1:terminal',
        kind: 'text',
        label: 'completed implementer',
      }),
    );
    addEvent(
      activity({
        ts: 2_200,
        stage: 'timeout',
        activityId: 'call-1:terminal',
        kind: 'error',
        label: 'timeout timeout',
      }),
    );

    expect(activityStore.get().items.map((item) => item.label)).toEqual([]);
  });
});
