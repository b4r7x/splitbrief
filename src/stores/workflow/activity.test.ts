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
      }),
    );

    expect(activityStore.get().items.map((item) => item.label)).toEqual([
      'checking repo',
      'running npm run typecheck',
      'session native-session-1',
    ]);
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

  it('clears activity on workflow cancellation', () => {
    addEvent(activity());
    addEvent({ type: 'workflow_cancelled', ts: 2_000, phase: 'implementing' });

    expect(activityStore.get().items).toEqual([]);
  });
});
