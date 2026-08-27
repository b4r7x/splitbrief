import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { allowedSettlingBriefReviewCommandsForPrompt } from '../../core/schemas/brief-review-command.js';
import { TASK_REVIEW_COMMANDS } from '../events/workflow-events.js';
import { parseServerMessage } from './protocol.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const BRIEF_HASH = 'a'.repeat(64);
const REPORT_HASH = 'b'.repeat(64);

function protectedRecoveryEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'brief_recovery_attempt_settled',
    ts: 1,
    phase: 'reviewing-briefs',
    version: 1,
    eventId: 'event-1',
    sessionId: 'session-1',
    epochId: 'epoch-1',
    recoveryRevision: 2,
    briefRevision: 2,
    briefHash: BRIEF_HASH,
    reportRevision: 2,
    reportHash: REPORT_HASH,
    operationId: 'operation-1',
    intentHash: BRIEF_HASH,
    attemptKind: 'manual-retry',
    status: 'settled',
    resultId: 'result-1',
    outcome: 'provider-failed',
    dispatchPossibility: 'none',
    remoteObservation: 'not-dispatched',
    providerCode: 'provider_unavailable',
    refusalCategory: 'provider',
    ...overrides,
  };
}

function taskReviewRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'T001',
    taskTitle: 'Review task',
    status: 'recovery-required',
    filesTouched: ['src/task.ts'],
    validation: { passed: false, summary: 'validation failed', stages: [] },
    evidence: { summary: 'needs review', expected: [], observed: [] },
    cost: {
      tokenUsage: makeUsage(),
    },
    availableCommands: [...TASK_REVIEW_COMMANDS],
    ...overrides,
  };
}

function taskReviewEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'task_review_needed',
    ts: 1,
    phase: 'implementing',
    ...taskReviewRequest(overrides),
  };
}

describe('parseServerMessage', () => {
  it('returns null for non-object values', () => {
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage('string')).toBeNull();
    expect(parseServerMessage([])).toBeNull();
  });

  it('returns null for object without kind', () => {
    expect(parseServerMessage({ foo: 'bar' })).toBeNull();
  });

  it('returns null for unknown kind', () => {
    expect(parseServerMessage({ kind: 'unknown_kind' })).toBeNull();
  });

  it('parses valid session_meta message', () => {
    const msg = {
      kind: 'session_meta',
      sessionId: 'sess-1',
      startedAt: 1000,
      mode: 'standard',
      feature: 'test',
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects session_meta with missing fields', () => {
    expect(parseServerMessage({ kind: 'session_meta', sessionId: 'sess-1' })).toBeNull();
  });

  it('parses valid event message', () => {
    const msg = {
      kind: 'event',
      payload: { type: 'warning', ts: 1000, phase: 'planning', message: 'heads up' },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses task_review events with legal recovery metadata', () => {
    const msg = {
      kind: 'event',
      payload: taskReviewEvent({
        recovery: {
          reason: 'budget-exceeded',
          message: 'Budget exceeded',
          availableActions: ['pause-run', 'abort-workflow'],
          recommendedAction: 'pause-run',
        },
      }),
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects task_review events with recovery actions illegal for the reason', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: taskReviewEvent({
          recovery: {
            reason: 'budget-exceeded',
            message: 'Budget exceeded',
            availableActions: ['continue'],
            recommendedAction: 'continue',
          },
        }),
      }),
    ).toBeNull();
  });

  it('rejects task_review events with a recommended recovery action not advertised', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: taskReviewEvent({
          recovery: {
            reason: 'validation-failed',
            message: 'Validation failed',
            availableActions: ['retry-same-worker'],
            recommendedAction: 'route-bigger-worker',
          },
        }),
      }),
    ).toBeNull();
  });

  it('rejects event with unknown payload type', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: { type: 'not_real', ts: 1000, phase: 'planning' },
      }),
    ).toBeNull();
  });

  it('rejects event with missing variant fields', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: { type: 'task_completed', ts: 1000, phase: 'implementing' },
      }),
    ).toBeNull();
  });

  it('rejects event with non-object payload', () => {
    expect(parseServerMessage({ kind: 'event', payload: 'bad' })).toBeNull();
  });

  it('rejects event with payload missing type', () => {
    expect(parseServerMessage({ kind: 'event', payload: { ts: 1000 } })).toBeNull();
  });

  it('rejects event with payload missing ts', () => {
    expect(parseServerMessage({ kind: 'event', payload: { type: 'foo' } })).toBeNull();
  });

  it('parses approval prompt requests with prompt-scoped allowed commands', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-1',
        kind: 'approval_needed',
        approvalType: 'briefs',
        filePath: 'tasks.md',
        allowedCommands: [...allowedSettlingBriefReviewCommandsForPrompt('briefs')],
      },
    };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses non-brief approval prompt requests with an explicit empty allowed-command list', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-1',
        kind: 'approval_needed',
        approvalType: 'spec',
        filePath: 'spec.md',
        allowedCommands: [],
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects approval prompt requests without prompt-scoped allowed commands', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-1',
          kind: 'approval_needed',
          approvalType: 'briefs',
          filePath: 'tasks.md',
        },
      }),
    ).toBeNull();
  });

  it('rejects approval prompt requests with commands outside the shared prompt contract', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-1',
          kind: 'approval_needed',
          approvalType: 'spec',
          filePath: 'spec.md',
          allowedCommands: ['approve'],
        },
      }),
    ).toBeNull();
  });

  it('parses recovery prompt requests with IPC-safe context fields only', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-recovery',
        kind: 'recovery_needed',
        issue: {
          id: 'rec-1',
          reason: 'retry-exhausted',
          phase: 'implementing',
          taskId: 'T001',
          taskTitle: 'Fix auth',
          files: ['src/auth.ts'],
          affectedTaskIds: ['T001'],
          selectedImplementerProfile: 'local-small',
          availableActions: ['retry-same-worker', 'route-bigger-worker', 'abort-workflow'],
          recommendedAction: 'route-bigger-worker',
          workerProfile: 'local-large',
          facts: { safeToContinue: false },
        },
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('parses transcript-projected recovery and conflict prompt requests', () => {
    const recovery = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-recovery',
        kind: 'recovery_needed',
        issue: {
          id: 'rec-1',
          reason: 'retry-exhausted',
          phase: 'implementing',
          taskId: 'T001',
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
          files: ['src/task.ts'],
          affectedTaskIds: ['T001'],
          availableActions: ['retry-same-worker', 'abort-workflow'],
          recommendedAction: 'retry-same-worker',
        },
      },
    };
    const conflict = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-conflict',
        kind: 'user_edit_conflict',
        conflict: {
          kind: 'current-task-conflict',
          files: [TRANSCRIPT_OMITTED_MESSAGE],
          affectedTaskIds: ['T001'],
          currentTaskId: 'T001',
          fileConflicts: [
            {
              file: TRANSCRIPT_OMITTED_MESSAGE,
              kind: 'current-task-conflict',
              affectedTaskIds: ['T001'],
            },
          ],
          safeToContinue: false,
          availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
        },
      },
    };

    expect(parseServerMessage(recovery)).toEqual(recovery);
    expect(parseServerMessage(conflict)).toEqual(conflict);
  });

  it('rejects recovery prompt requests with prose message or details', () => {
    const baseIssue = {
      id: 'rec-1',
      reason: 'retry-exhausted',
      phase: 'implementing',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'abort-workflow'],
      recommendedAction: 'retry-same-worker',
    };

    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-recovery',
          kind: 'recovery_needed',
          issue: { ...baseIssue, message: 'freeform prose' },
        },
      }),
    ).toBeNull();
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-recovery',
          kind: 'recovery_needed',
          issue: { ...baseIssue, details: ['freeform prose'] },
        },
      }),
    ).toBeNull();
  });

  it('parses task_review prompt requests with legal recovery metadata', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-review',
        kind: 'task_review',
        request: taskReviewRequest({
          recovery: {
            reason: 'budget-exceeded',
            message: 'Budget exceeded',
            availableActions: ['pause-run', 'abort-workflow'],
            recommendedAction: 'pause-run',
          },
        }),
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects task_review prompt requests with recovery actions illegal for the reason', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-review',
          kind: 'task_review',
          request: taskReviewRequest({
            recovery: {
              reason: 'budget-exceeded',
              message: 'Budget exceeded',
              availableActions: ['continue'],
              recommendedAction: 'continue',
            },
          }),
        },
      }),
    ).toBeNull();
  });

  it('rejects task_review prompt requests with a recommended recovery action not advertised', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-review',
          kind: 'task_review',
          request: taskReviewRequest({
            recovery: {
              reason: 'validation-failed',
              message: 'Validation failed',
              availableActions: ['retry-same-worker'],
              recommendedAction: 'route-bigger-worker',
            },
          }),
        },
      }),
    ).toBeNull();
  });

  it('rejects prompt_request with missing requestId', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: { kind: 'approval_needed', approvalType: 'spec', filePath: 's' },
      }),
    ).toBeNull();
  });

  it('rejects the removed external_changes prompt kind on prompt_request', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: { requestId: 'req-1', kind: 'external_changes' },
      }),
    ).toBeNull();
  });

  it('rejects the removed replay_meta message kind', () => {
    expect(
      parseServerMessage({ kind: 'replay_meta', totalEvents: 5, firstTs: 100, lastTs: 200 }),
    ).toBeNull();
  });

  it('parses valid error message', () => {
    const msg = { kind: 'error', code: 'already_attached', message: 'Client already connected' };
    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('rejects error with wrong code', () => {
    expect(parseServerMessage({ kind: 'error', code: 'other', message: 'fail' })).toBeNull();
  });

  it('rejects error with missing message', () => {
    expect(parseServerMessage({ kind: 'error', code: 'already_attached' })).toBeNull();
  });

  it('round-trips the bounded protected recovery projection without runner payloads', () => {
    const message = { kind: 'event', payload: protectedRecoveryEvent() };
    const parsed = parseServerMessage(JSON.parse(JSON.stringify(message)));

    expect(parsed).toEqual(message);
  });

  it('rejects recovery records that carry secrets or oversized protected identifiers', () => {
    expect(
      parseServerMessage({
        kind: 'event',
        payload: protectedRecoveryEvent({ apiKey: 'secret-token-1' }),
      }),
    ).toBeNull();
    expect(
      parseServerMessage({
        kind: 'event',
        payload: protectedRecoveryEvent({ providerCode: 'x'.repeat(129) }),
      }),
    ).toBeNull();
  });

  it('replays duplicate recovery records byte-equivalently', () => {
    const payload = protectedRecoveryEvent();
    const first = parseServerMessage({ kind: 'event', payload });
    const replay = parseServerMessage({
      kind: 'event',
      payload: Object.fromEntries(Object.entries(payload).reverse()),
    });

    expect(first).toEqual(replay);
    expect(JSON.stringify(first)).toBe(JSON.stringify(replay));
  });
});
