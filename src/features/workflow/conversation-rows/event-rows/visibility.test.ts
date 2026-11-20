import { describe, expect, it } from 'vitest';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './visibility.js';

describe('isTranscriptRowlessEvent', () => {
  it.each(['build', undefined] as const)('hides a steerable call with seat %s', (seat) => {
    expect(
      isTranscriptRowlessEvent({ type: 'steerable_call', ts: 0, phase: 'implementing', seat }),
    ).toBe(true);
  });

  it('keeps a boundary park the user asked for', () => {
    const park: EngineEvent = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };

    expect(isTranscriptRowlessEvent(park)).toBe(false);
  });

  it('`workflow_complete` none has a row', () => {
    const complete = (review?: 'none' | 'passed'): EngineEvent => ({
      type: 'workflow_complete',
      ts: 0,
      phase: 'complete',
      ...(review !== undefined && { review }),
    });

    expect(isTranscriptRowlessEvent(complete('none'))).toBe(false);
    expect(isTranscriptRowlessEvent(complete('passed'))).toBe(true);
    expect(isTranscriptRowlessEvent(complete())).toBe(true);
  });

  it('hides a drift report', () => {
    expect(
      isTranscriptRowlessEvent({
        type: 'drift_report',
        ts: 0,
        phase: 'final-review',
        passed: false,
        errorCount: 1,
        warningCount: 0,
      }),
    ).toBe(true);
  });

  it('gives a seat retry no transcript row', () => {
    expect(
      isTranscriptRowlessEvent({
        type: 'seat_retry',
        ts: 0,
        phase: 'planning',
        seat: 'plan',
        attempt: 1,
        delayMs: 2_000,
      }),
    ).toBe(true);
  });

  it('hides a refused seat answer that the seat is asked again for', () => {
    expect(
      isTranscriptRowlessEvent({
        type: 'seat_answer_refused',
        ts: 0,
        phase: 'final-review',
        seat: 'reviewer',
        reasons: ['Task T001 is missing from the verdict.'],
      }),
    ).toBe(true);
  });

  it('paints no row for a debug event', () => {
    expect(
      isTranscriptRowlessEvent({
        type: 'debug',
        ts: 0,
        phase: 'planning',
        message:
          'Planner session expired; the call runs again on a fresh session with the conversation so far.',
        category: 'planner',
        code: 'planner_session_expired',
      }),
    ).toBe(true);
  });

  it('is true for row-less event types and false for visible rows', () => {
    const heartbeat: EngineEvent = {
      type: 'planner_heartbeat',
      ts: 0,
      phase: 'planning',
      elapsedMs: 1000,
    };
    const status: EngineEvent = {
      type: 'planner_status',
      ts: 0,
      phase: 'planning',
      status: 'running',
    };
    const tokens: EngineEventOf<'task_settled'> = {
      type: 'task_settled',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',

      retryCount: 0,
    };
    const text: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      text: 'hello',
    };
    const reviewFixStarted: EngineEventOf<'review_fix_started'> = {
      type: 'review_fix_started',
      ts: 0,
      phase: 'implementing',
      cycle: 1,
      taskIds: [taskId('T001')],
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
    const runnerHeartbeat: EngineEvent = {
      type: 'runner_call_heartbeat',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 3,
    };

    expect(isTranscriptRowlessEvent(heartbeat)).toBe(true);
    expect(isTranscriptRowlessEvent(status)).toBe(true);
    expect(isTranscriptRowlessEvent(tokens)).toBe(true);
    expect(isTranscriptRowlessEvent(stalled)).toBe(true);
    expect(isTranscriptRowlessEvent(stallCleared)).toBe(true);
    expect(isTranscriptRowlessEvent(runnerHeartbeat)).toBe(true);
    expect(isTranscriptRowlessEvent(reviewFixStarted)).toBe(true);
    expect(isTranscriptRowlessEvent(text)).toBe(false);
  });
});
