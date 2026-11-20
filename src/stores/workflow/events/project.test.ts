import { describe, it, expect } from 'vitest';
import { projectEventForTuiEventLog } from './project.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  makeRunnerCallCompleted,
  makeRunnerCallHeartbeat,
} from '#testing/helpers/events/runner-call.js';
import { makeRunnerActivity } from '#testing/helpers/events/workflow-activity.js';

describe('projectEventForTuiEventLog', () => {
  it('drops runner_call_stalled and runner_call_stall_cleared', () => {
    expect(
      projectEventForTuiEventLog({
        type: 'runner_call_stalled',
        ts: 1000,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 1,
        silentMs: 60_000,
      }),
    ).toBeNull();
    expect(
      projectEventForTuiEventLog({
        type: 'runner_call_stall_cleared',
        ts: 2000,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 2,
      }),
    ).toBeNull();
  });

  it('drops runner_call_heartbeat, which only moves the freshness clock', () => {
    expect(projectEventForTuiEventLog(makeRunnerCallHeartbeat())).toBeNull();
  });

  it('keeps the description and the line count of a command activity', () => {
    const description = 'Count the action flags\nand show the changed files\u001b[31m';
    expect(
      projectEventForTuiEventLog(makeRunnerActivity({ description, moreLines: 2 })),
    ).toMatchObject({
      description: 'Count the action flags and show the changed files',
      moreLines: 2,
      redacted: true,
    });
  });

  it('keeps the end of a finished call without its session, usage or runner', () => {
    expect(
      projectEventForTuiEventLog(
        makeRunnerCallCompleted({
          taskId: taskId('T001'),
          runnerName: 'codex',
          model: 'gpt-5-mini',

          nativeSessionId: 'native-session-1',
        }),
      ),
    ).toEqual({
      type: 'runner_call_completed',
      ts: 2_500,
      phase: 'implementing',
      taskId: 'T001',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 1_000,
      endedAt: 2_500,
      durationMs: 1_500,

      nativeSessionId: null,
    });
  });
});
