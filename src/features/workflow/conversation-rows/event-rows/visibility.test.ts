import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './visibility.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { eventRows } from '#testing/helpers/event-rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

const briefRecoveryLifecycleEventTypes = [
  'brief_recovery_quality_reported',
  'brief_recovery_auto_repair_exhausted',
  'brief_recovery_attempt_accepted',
  'brief_recovery_attempt_started',
  'brief_recovery_attempt_settled',
  'brief_recovery_attempt_unresolved',
  'brief_recovery_provider_failed',
  'brief_recovery_input_queued',
  'brief_recovery_input_applied',
  'brief_recovery_stale_ignored',
  'brief_recovery_rejected',
  'brief_recovery_refused',
] as const satisfies readonly EngineEvent['type'][];

function briefRecoveryEvent(type: (typeof briefRecoveryLifecycleEventTypes)[number]): EngineEvent {
  return { type, ts: 0, phase: 'reviewing-briefs' } as EngineEvent;
}

describe('isTranscriptRowlessEvent', () => {
  it('keeps every canonical Brief recovery lifecycle event rowless', () => {
    for (const type of briefRecoveryLifecycleEventTypes) {
      const event = briefRecoveryEvent(type);
      expect(isTranscriptRowlessEvent(event)).toBe(true);
      expect(
        eventRows({
          event,
          globalIndex: 0,
          expanded: false,
          ctx: { width: 80, viewportRows: 20, streaming },
        }),
      ).toEqual([]);
    }
  });

  it('is true for row-less event types and false for visible rows', () => {
    const heartbeat: EngineEvent = {
      type: 'planner_heartbeat',
      ts: 0,
      phase: 'planning',
      elapsedMs: 1000,
      accumulatedTokens: 10,
    };
    const status: EngineEvent = {
      type: 'planner_status',
      ts: 0,
      phase: 'planning',
      status: 'running',
    };
    const tokens: EngineEventOf<'task_tokens'> = {
      type: 'task_tokens',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',
      implementerTokens: 10,
      escalationTokens: 0,
      retryCount: 0,
    };
    const text: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      text: 'hello',
    };
    const stalled: EngineEvent = {
      type: 'runner_call_stalled',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      silentMs: 60_000,
    };
    const stallCleared: EngineEvent = {
      type: 'runner_call_stall_cleared',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
    };

    expect(isTranscriptRowlessEvent(heartbeat)).toBe(true);
    expect(isTranscriptRowlessEvent(status)).toBe(true);
    expect(isTranscriptRowlessEvent(tokens)).toBe(true);
    expect(isTranscriptRowlessEvent(stalled)).toBe(true);
    expect(isTranscriptRowlessEvent(stallCleared)).toBe(true);
    expect(isTranscriptRowlessEvent(text)).toBe(false);
  });
});
