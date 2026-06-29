import { describe, it, expect, vi } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { HeadlessJsonRecordSchema } from '../public-json.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { createStdoutJsonSink } from './stdout-json.js';

describe('stdoutJsonSink', () => {
  it('writes one public event record per NDJSON line', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const sink = createStdoutJsonSink();
    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' });
    sink({ type: 'instant_plan_received', ts: 200, phase: 'planning', taskCount: 3 });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^\{"type":"event"/);
    expect(writes[0]).toMatch(/\n$/);
    const first = HeadlessJsonRecordSchema.parse(JSON.parse(writes[0]!.trimEnd()));
    const second = HeadlessJsonRecordSchema.parse(JSON.parse(writes[1]!.trimEnd()));
    expect(first).toEqual({
      type: 'event',
      data: { type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' },
    });
    expect(
      second.type === 'event' && second.data.type === 'instant_plan_received'
        ? second.data.taskCount
        : undefined,
    ).toBe(3);

    spy.mockRestore();
  });

  it('applies transcript-off protection before writing public event records', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const sink = createStdoutJsonSink({ persistTranscript: false });
      sink({
        type: 'workflow_started',
        ts: 100,
        phase: 'idle',
        feature: 'secret feature prompt',
      });
      sink({ type: 'planner_text', ts: 110, phase: 'planning', text: 'secret transcript' });

      expect(writes).toHaveLength(1);
      const record = HeadlessJsonRecordSchema.parse(JSON.parse(writes[0]!.trimEnd()));
      expect(record).toEqual({
        type: 'event',
        data: {
          type: 'workflow_started',
          ts: 100,
          phase: 'idle',
          feature: TRANSCRIPT_OMITTED_MESSAGE,
        },
      });
      expect(JSON.stringify(record)).not.toContain('secret');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps runner activity control metadata when transcript persistence is disabled', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const sink = createStdoutJsonSink({ persistTranscript: false });
      sink({
        type: 'runner_call_activity',
        ts: 120,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        activityId: 'call-1:tool:tool-1',
        stage: 'completed',
        kind: 'command',
        label: 'running echo private-runner-output-92741',
        target: 'echo private-runner-output-92741',
        redacted: true,
      });

      expect(writes).toHaveLength(1);
      const record = HeadlessJsonRecordSchema.parse(JSON.parse(writes[0]!.trimEnd()));
      expect(record).toMatchObject({
        type: 'event',
        data: {
          type: 'runner_call_activity',
          activityId: 'call-1:tool:tool-1',
          stage: 'completed',
          kind: 'command',
          label: 'running command',
          rawAvailable: false,
          redacted: true,
        },
      });
      expect(JSON.stringify(record)).not.toContain('"target"');
      expect(JSON.stringify(record)).not.toContain('"expandId"');
      expect(JSON.stringify(record)).not.toContain('private-runner-output-92741');
    } finally {
      spy.mockRestore();
    }
  });

  it('omits structured transcript fields before writing public event records', () => {
    const sentinel = 'stdout-privacy-sentinel-74126';
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const sink = createStdoutJsonSink({ persistTranscript: false });
      sink({
        type: 'task_review_needed',
        ts: 130,
        phase: 'implementing',
        taskId: taskId('T021'),
        taskTitle: `review ${sentinel}`,
        status: 'failed',
        filesTouched: [`src/${sentinel}.ts`],
        validation: {
          passed: false,
          summary: `validation ${sentinel}`,
          stages: [{ stage: 'test', passed: false, errorSummary: `error ${sentinel}` }],
        },
        evidence: {
          summary: `evidence ${sentinel}`,
          expected: [`expected ${sentinel}`],
          observed: [`observed ${sentinel}`],
        },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 1,
            implementerOutput: 1,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        recovery: {
          reason: 'validation-failed',
          availableActions: ['retry-same-worker'],
          recommendedAction: 'retry-same-worker',
          message: `recover ${sentinel}`,
        },
        availableCommands: ['continue', 'redo-task', 'edit-notes', 'revise-plan', 'abort'],
      });
      sink({
        type: 'task_retry',
        ts: 131,
        phase: 'implementing',
        taskId: taskId('T021'),
        attempt: 1,
        maxRetries: 2,
        error: `retry ${sentinel}`,
      });

      expect(writes).toHaveLength(2);
      const records = writes.map((line) =>
        HeadlessJsonRecordSchema.parse(JSON.parse(line.trimEnd())),
      );
      expect(records[0]).toMatchObject({
        type: 'event',
        data: {
          type: 'task_review_needed',
          taskId: taskId('T021'),
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
          filesTouched: [TRANSCRIPT_OMITTED_MESSAGE],
          validation: {
            summary: TRANSCRIPT_OMITTED_MESSAGE,
            stages: [{ errorSummary: TRANSCRIPT_OMITTED_MESSAGE }],
          },
          evidence: {
            summary: TRANSCRIPT_OMITTED_MESSAGE,
            expected: [TRANSCRIPT_OMITTED_MESSAGE],
            observed: [TRANSCRIPT_OMITTED_MESSAGE],
          },
          recovery: { message: TRANSCRIPT_OMITTED_MESSAGE },
        },
      });
      expect(records[1]).toMatchObject({
        type: 'event',
        data: {
          type: 'task_retry',
          taskId: taskId('T021'),
          attempt: 1,
          maxRetries: 2,
          error: TRANSCRIPT_OMITTED_MESSAGE,
        },
      });
      expect(JSON.stringify(records)).not.toContain(sentinel);
    } finally {
      spy.mockRestore();
    }
  });
});
