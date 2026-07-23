import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './visibility.js';

describe('isTranscriptRowlessEvent', () => {
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
