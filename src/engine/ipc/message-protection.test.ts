import { describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../runners/types.js';
import { IPC_MAX_FRAME_BYTES, type ServerMessage } from './protocol.js';
import { protectServerMessage } from './message-protection.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

describe('protectServerMessage', () => {
  it('preserves immutable artifact text byte-for-byte outside generic consumer protection', () => {
    const prefix = 'sk-artifact-secret-21893\u001b]0;control\u0007\n';
    const text = `${prefix}${'\u0000'.repeat(
      PLANNER_ARTIFACT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8'),
    )}`;
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'artifact-review-1',
        kind: 'artifact_review',
        review: { label: 'Custom planner artifact', text },
      },
    };

    for (const persistTranscript of [true, false]) {
      const protectedMsg = protectServerMessage(msg, { persistTranscript });
      expect(protectedMsg).toBe(msg);
      expect(JSON.stringify(protectedMsg)).toContain('sk-artifact-secret-21893');
      expect(Buffer.byteLength(JSON.stringify(protectedMsg) + '\n', 'utf8')).toBeLessThanOrEqual(
        IPC_MAX_FRAME_BYTES,
      );
    }
  });

  it('drops untransportable artifact reviews without substituting a warning frame', () => {
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'artifact-review-too-large',
        kind: 'artifact_review',
        review: {
          label: 'Custom planner artifact',
          text: `${'\u0000'.repeat(PLANNER_ARTIFACT_MAX_BYTES)}x`,
        },
      },
    };

    expect(protectServerMessage(msg, { persistTranscript: true })).toBeNull();
  });

  it('redacts secrets and strips terminal controls in event frames', () => {
    const msg: ServerMessage = {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'token sk-abcdefghijklmnopqrst \u001b]0;owned\u0007done',
      },
    };
    expect(protectServerMessage(msg, { persistTranscript: true })).toEqual({
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'token sk-***REDACTED*** done',
      },
    });
  });

  it('drops transcript-only runner frames when transcript persistence is disabled', () => {
    const msg: ServerMessage = {
      kind: 'event',
      payload: {
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'hidden transcript',
      },
    };
    expect(protectServerMessage(msg, { persistTranscript: false })).toBeNull();
  });

  it('projects prompt requests when transcript persistence is disabled', () => {
    const questionMsg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-question-1',
        kind: 'question_asked',
        question: {
          id: 'question-1',
          type: 'choice',
          text: 'ipc-question-secret-41802',
          options: ['ipc-choice-secret-41802'],
          default: 'ipc-default-secret-41802',
        },
        num: 1,
        total: 1,
      },
    };
    const recoveryMsg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-recovery-1',
        kind: 'recovery_needed',
        issue: {
          id: 'recovery-1',
          reason: 'retry-exhausted',
          phase: 'implementing',
          taskId: taskId('T001'),
          taskTitle: 'ipc-recovery-task-context',
          files: ['src/task.ts'],
          affectedTaskIds: [taskId('T001')],
          selectedImplementerProfile: 'small-worker',
          availableActions: ['retry-same-worker', 'abort-workflow'],
          recommendedAction: 'retry-same-worker',
          workerProfile: 'large-worker',
          facts: { safeToContinue: false },
        },
      },
    };

    const frames = [
      protectServerMessage(questionMsg, { persistTranscript: false }),
      protectServerMessage(recoveryMsg, { persistTranscript: false }),
    ];
    expect(frames).toEqual([
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-question-1',
          kind: 'question_asked',
          question: {
            id: 'question-1',
            type: 'choice',
            text: TRANSCRIPT_OMITTED_MESSAGE,
            options: [TRANSCRIPT_OMITTED_MESSAGE],
            default: TRANSCRIPT_OMITTED_MESSAGE,
          },
          num: 1,
          total: 1,
        },
      },
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-recovery-1',
          kind: 'recovery_needed',
          issue: {
            id: 'recovery-1',
            reason: 'retry-exhausted',
            phase: 'implementing',
            taskId: taskId('T001'),
            taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
            files: ['src/task.ts'],
            affectedTaskIds: [taskId('T001')],
            selectedImplementerProfile: 'small-worker',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
            workerProfile: 'large-worker',
            facts: { safeToContinue: false },
          },
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain('ipc-question-secret-41802');
    expect(JSON.stringify(frames)).not.toContain('ipc-choice-secret-41802');
    expect(JSON.stringify(frames)).not.toContain('ipc-recovery-task-context');
    expect(JSON.stringify(frames)).not.toContain('message');
    expect(JSON.stringify(frames)).not.toContain('details');
  });

  it('projects user-edit conflict prompt requests when transcript persistence is disabled', () => {
    const rawPath = 'src/private-conflict-file.ts';
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-conflict-1',
        kind: 'user_edit_conflict',
        conflict: {
          kind: 'current-task-conflict',
          files: [rawPath],
          affectedTaskIds: [taskId('T001')],
          currentTaskId: taskId('T001'),
          fileConflicts: [
            {
              file: rawPath,
              kind: 'current-task-conflict',
              affectedTaskIds: [taskId('T001')],
            },
          ],
          safeToContinue: false,
          availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
        },
      },
    };

    const protectedMsg = protectServerMessage(msg, { persistTranscript: false });
    expect(protectedMsg).toEqual({
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-conflict-1',
        kind: 'user_edit_conflict',
        conflict: {
          kind: 'current-task-conflict',
          files: [TRANSCRIPT_OMITTED_MESSAGE],
          affectedTaskIds: [taskId('T001')],
          currentTaskId: taskId('T001'),
          fileConflicts: [
            {
              file: TRANSCRIPT_OMITTED_MESSAGE,
              kind: 'current-task-conflict',
              affectedTaskIds: [taskId('T001')],
            },
          ],
          safeToContinue: false,
          availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
        },
      },
    });
    expect(JSON.stringify(protectedMsg)).not.toContain(rawPath);
  });

  it('uses the central event projection for task review prompt requests', () => {
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-review-1',
        kind: 'task_review',
        request: {
          taskId: taskId('T001'),
          taskTitle: 'ipc-task-review-title-secret-79231',
          status: 'recovery-required',
          filesTouched: ['src/secret.ts'],
          validation: {
            passed: false,
            summary: 'ipc-validation-secret-79231',
            stages: [{ stage: 'test', passed: false, errorSummary: 'ipc-stage-secret-79231' }],
          },
          evidence: {
            path: 'src/evidence-secret.ts',
            summary: 'ipc-evidence-secret-79231',
            expected: ['ipc-expected-secret-79231'],
            observed: ['ipc-observed-secret-79231'],
          },
          cost: {
            tokenUsage: makeUsage({
              plannerInput: 1,
              plannerOutput: 2,
              implementerInput: 3,
              implementerOutput: 4,
              escalationInput: 5,
              escalationOutput: 6,
            }),
          },
          recovery: {
            reason: 'retry-exhausted',
            message: 'ipc-review-recovery-secret-79231',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
          },
          availableCommands: ['continue', 'abort'],
        },
      },
    };

    const protectedMsg = protectServerMessage(msg, { persistTranscript: false });
    expect(protectedMsg).toEqual({
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-review-1',
        kind: 'task_review',
        request: expect.objectContaining({
          taskId: 'T001',
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
          status: 'recovery-required',
          filesTouched: [TRANSCRIPT_OMITTED_MESSAGE],
          validation: expect.objectContaining({
            summary: TRANSCRIPT_OMITTED_MESSAGE,
            stages: [
              expect.objectContaining({
                errorSummary: TRANSCRIPT_OMITTED_MESSAGE,
              }),
            ],
          }),
          evidence: expect.objectContaining({
            path: TRANSCRIPT_OMITTED_MESSAGE,
            summary: TRANSCRIPT_OMITTED_MESSAGE,
            expected: [TRANSCRIPT_OMITTED_MESSAGE],
            observed: [TRANSCRIPT_OMITTED_MESSAGE],
          }),
          recovery: {
            reason: 'retry-exhausted',
            message: TRANSCRIPT_OMITTED_MESSAGE,
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
          },
          availableCommands: ['continue', 'abort'],
        }),
      },
    });
    expect(JSON.stringify(protectedMsg)).not.toContain('ipc-task-review-title-secret-79231');
    expect(JSON.stringify(protectedMsg)).not.toContain('ipc-validation-secret-79231');
    expect(JSON.stringify(protectedMsg)).not.toContain('ipc-review-recovery-secret-79231');
  });

  it('bounds oversized warning events when transcript persistence is disabled', () => {
    const msg: ServerMessage = {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'x'.repeat(IPC_MAX_FRAME_BYTES + 1024),
      },
    };

    const protectedMsg = protectServerMessage(msg, { persistTranscript: false });
    expect(protectedMsg?.kind).toBe('event');
    if (protectedMsg?.kind === 'event') {
      expect(protectedMsg.payload.type).toBe('warning');
      const message = (protectedMsg.payload as { message: string }).message;
      expect(message).toBe(TRANSCRIPT_OMITTED_MESSAGE);
      expect(JSON.stringify(protectedMsg)).not.toContain('dropped oversized warning frame');
      expect(Buffer.byteLength(JSON.stringify(protectedMsg), 'utf8')).toBeLessThan(
        IPC_MAX_FRAME_BYTES,
      );
    }
  });

  it('returns a bounded warning for protected messages that still exceed the public limit', () => {
    const expected = Array.from(
      { length: 4_000 },
      (_value, index) => `item-${index}-${'x'.repeat(120)}`,
    );
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-1',
        kind: 'task_review',
        request: {
          taskId: taskId('T001'),
          taskTitle: 'Review task',
          status: 'done',
          filesTouched: ['a.ts'],
          validation: { passed: true, summary: 'ok', stages: [] },
          evidence: { summary: 'ok', expected, observed: [] },
          cost: {
            tokenUsage: makeUsage(),
          },
          availableCommands: ['continue'],
        },
      },
    };

    const protectedMsg = protectServerMessage(msg, { persistTranscript: true });
    expect(protectedMsg?.kind).toBe('event');
    if (protectedMsg?.kind === 'event') {
      expect(protectedMsg.payload.type).toBe('warning');
      expect((protectedMsg.payload as { message: string }).message).toContain(
        'dropped oversized prompt_request frame',
      );
      expect(Buffer.byteLength(JSON.stringify(protectedMsg), 'utf8')).toBeLessThan(
        IPC_MAX_FRAME_BYTES,
      );
    }
  });
});
