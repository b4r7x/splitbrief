import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../engine/events/types.js';
import {
  isRunnerCallEvent,
  isRunnerCallTranscriptRowSuppressed,
  runnerCallId,
} from './runner-call-classification.js';

function runnerActivity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>> = {},
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 0,
    phase: 'researching',
    callId: overrides.callId ?? 'call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? 'activity-1',
    stage: 'updated',
    kind: 'read',
    label: 'reading file.ts',
    redacted: false,
    ...overrides,
  };
}

describe('runnerCallId', () => {
  it('returns the call id for runner-call events', () => {
    expect(runnerCallId(runnerActivity({ callId: 'call-42' }))).toBe('call-42');
  });

  it('returns null for non-runner events', () => {
    expect(runnerCallId({ type: 'planner_text', ts: 0, phase: 'planning', text: 'hi' })).toBeNull();
  });
});

describe('isRunnerCallTranscriptRowSuppressed', () => {
  it('suppresses non-activity runner-call rows but keeps activity rows renderable', () => {
    expect(
      isRunnerCallTranscriptRowSuppressed({
        type: 'runner_call_started',
        ts: 0,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        runnerName: 'codex',
        sequence: 1,
      }),
    ).toBe(true);
    expect(isRunnerCallTranscriptRowSuppressed(runnerActivity())).toBe(false);
  });
});

describe('isRunnerCallEvent', () => {
  it('classifies runner-call activity through the shared path', () => {
    expect(isRunnerCallEvent(runnerActivity())).toBe(true);
  });
});
