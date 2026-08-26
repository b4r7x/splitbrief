import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../../engine/runners/types.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../core/schemas/brief-recovery/document.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { taskId } from '../../core/schemas/task.js';
import { RPC_MAX_FRAME_BYTES } from './types.js';
import { createResponseWriter } from './writer.js';

function createCaptureStream(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return { chunks, stream };
}

function parseJsonLines(chunks: string[]): unknown[] {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function waitForWriter(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const RECOVERY_STATUSES = [
  'blocked',
  'retrying',
  'unresolved',
  'storage-blocked',
  'ready',
  'rejected',
] as const;
const RECOVERY_SECRET = 'sk-rpc-projection-secret-abcdefghijklmnop';
type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

function evidenceRef(path: string, hash = 'brief-hash') {
  return { revision: 1, hash, path };
}

function attemptSummary(status: 'started' | 'unresolved') {
  return {
    operationId: 'operation-1',
    status,
    dispatchPossibility: 'possible' as const,
    outcome: null,
    reservation: {
      accountingKey: {
        sessionId: 'session-1',
        epochId: 'epoch-1',
        operationId: 'operation-1',
        generation: 1,
      },
      amount: 1,
      state: 'held' as const,
    },
  };
}

function recoveryProjection(status: RecoveryStatus): BriefRecoveryProjectionV1 {
  const storageBlocked = status === 'storage-blocked';
  const rejected = status === 'rejected';
  const unavailable = storageBlocked || rejected;
  const activeBrief = unavailable ? null : evidenceRef('tasks.md');
  const hasIssue = status === 'blocked' || status === 'retrying' || status === 'unresolved';
  const issue = {
    code: 'empty_task_list',
    severity: 'error' as const,
    taskId: null,
    message: RECOVERY_SECRET,
  };

  return BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId: 'session-1',
    stateRevision: 9,
    recoveryRevision: 4,
    epochId: 'epoch-1',
    status,
    origin: unavailable ? null : { mode: 'standard', entry: 'initial' },
    continuation: unavailable
      ? null
      : { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief,
    matchingReport:
      activeBrief === null
        ? null
        : {
            briefHash: 'brief-hash',
            report: evidenceRef('brief-quality.json'),
            ruleVersion: 'brief-quality-v1',
            issues: hasIssue ? [issue] : [],
          },
    blocker: unavailable
      ? { kind: 'storage', code: 'brief_storage_invalid', message: RECOVERY_SECRET }
      : status === 'blocked'
        ? { kind: 'quality', issues: [issue] }
        : status === 'unresolved'
          ? { kind: 'unresolved', code: 'brief_unresolved', operationId: 'operation-1' }
          : null,
    allowedActions: unavailable
      ? ['status']
      : status === 'ready'
        ? ['approve', 'status']
        : status === 'unresolved'
          ? ['resolve-unresolved', 'edit', 'reject', 'status']
          : status === 'retrying'
            ? ['edit', 'reject', 'status']
            : ['retry', 'edit', 'reject', 'status'],
    activeOperation:
      status === 'retrying'
        ? attemptSummary('started')
        : status === 'unresolved'
          ? attemptSummary('unresolved')
          : null,
    latestAttempt:
      status === 'retrying'
        ? attemptSummary('started')
        : status === 'unresolved'
          ? attemptSummary('unresolved')
          : null,
    queuedInputs:
      status === 'retrying' || status === 'unresolved'
        ? { ids: ['input-1'], count: 1, carriedCount: 0, heldCount: 1, releasedCount: 0 }
        : { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  });
}

describe('createResponseWriter', () => {
  it('writes ack, error, status, and event responses as JSON lines', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({ stream, onClose: () => {} });
    const event = {
      type: 'warning',
      ts: 1,
      phase: 'planning',
      message: 'watch this',
    } satisfies EngineEvent;

    writer.ack('approve');
    writer.error('bad command');
    writer.status({ phase: 'planning' });
    writer.event(event);

    expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true);
    expect(parseJsonLines(chunks)).toEqual([
      { type: 'ack', command: 'approve' },
      { type: 'error', error: 'bad command' },
      { type: 'status', data: { phase: 'planning' } },
      { type: 'event', data: event },
    ]);
  });

  it('keeps embedded newlines inside a single JSON response line', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({ stream, onClose: () => {} });

    writer.status({ message: 'line one\nline two' });

    const output = chunks.join('');
    expect(output.split('\n')).toHaveLength(2);
    expect(parseJsonLines(chunks)).toEqual([
      { type: 'status', data: { message: 'line one\nline two' } },
    ]);
  });

  it('pauses for drain, resumes, and closes when pending output reaches its cap', async () => {
    const chunks: string[] = [];
    const releases: Array<() => void> = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        releases.push(callback);
      },
    });
    const reasons: string[] = [];
    const frameBytes = Buffer.byteLength('{"type":"ack","command":"status"}\n', 'utf8');
    const writer = createResponseWriter({
      stream,
      onClose: (reason) => reasons.push(reason),
      maxPendingBytes: frameBytes * 3,
    });

    writer.ack('status');
    writer.ack('status');
    writer.ack('status');
    expect(chunks).toHaveLength(1);
    expect(reasons).toEqual([]);

    releases.shift()?.();
    await waitForWriter();
    expect(chunks).toHaveLength(2);

    writer.ack('status');
    writer.ack('status');
    expect(reasons).toEqual([`pending RPC output exceeded ${frameBytes * 3} bytes`]);
    expect(chunks).toHaveLength(2);

    releases.shift()?.();
    await waitForWriter();
    stream.destroy();
  });

  it.each(RECOVERY_STATUSES)(
    'writes a protected public projection for %s without exposing transcript secrets',
    (status) => {
      const { chunks, stream } = createCaptureStream();
      const writer = createResponseWriter({ stream, onClose: () => {} });
      const projection = recoveryProjection(status);

      expect(writer.status({ briefRecovery: projection })).toBe(true);

      const lines = parseJsonLines(chunks);
      expect(lines).toEqual([
        {
          type: 'status',
          data: expect.objectContaining({
            briefRecovery: expect.objectContaining({
              status,
              sessionId: 'session-1',
              allowedActions: projection.allowedActions,
            }),
          }),
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(RECOVERY_SECRET);
    },
  );

  it('writes at-limit immutable artifact text unchanged in one RPC status frame', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });
    const text = '\u0000'.repeat(PLANNER_ARTIFACT_MAX_BYTES);

    expect(
      writer.status({
        pending: 'approval',
        approvalType: 'artifact',
        review: { label: 'Custom planner artifact', text },
      }),
    ).toBe(true);

    expect(chunks).toHaveLength(1);
    expect(Buffer.byteLength(chunks[0] ?? '', 'utf8')).toBeLessThanOrEqual(RPC_MAX_FRAME_BYTES);
    expect(parseJsonLines(chunks)).toEqual([
      {
        type: 'status',
        data: {
          pending: 'approval',
          approvalType: 'artifact',
          review: { label: 'Custom planner artifact', text },
        },
      },
    ]);
  });

  it('fails closed without writing an oversized artifact review status', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({ stream, onClose: () => {} });

    expect(
      writer.status({
        pending: 'approval',
        approvalType: 'artifact',
        review: {
          label: 'Custom planner artifact',
          text: 'artifact-rpc-over-limit-91743'.padEnd(PLANNER_ARTIFACT_MAX_BYTES + 1, 'x'),
        },
      }),
    ).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('protects live event responses with the RPC transcript policy', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });

    writer.event({
      type: 'runner_call_text_delta',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: 'hidden transcript',
    });
    writer.event({
      type: 'runner_call_activity',
      ts: 2,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:tool:tool-1',
      stage: 'completed',
      kind: 'command',
      label: 'running echo sk-abcdefghijklmnopqrst',
      target: 'echo sk-abcdefghijklmnopqrst',
      redacted: false,
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'event',
        data: expect.objectContaining({
          type: 'runner_call_activity',
          label: 'running command',
          rawAvailable: false,
          redacted: true,
        }),
      },
    ]);
    expect(JSON.stringify(lines[0])).not.toContain('"target"');
    expect(JSON.stringify(lines[0])).not.toContain('"expandId"');
    expect(JSON.stringify(lines)).not.toContain('echo sk-abcdefghijklmnopqrst');
  });

  it('omits transcript-bearing status fields when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });

    writer.status({
      sessionId: 'session-1',
      phase: 'planning',
      state: { feature: 'secret feature prompt' },
      question: 'secret question',
      issue: {
        id: 'rec-rpc-1',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        taskId: 'T001',
        taskTitle: 'rpc-recovery-task-secret-29140',
        files: ['src/target.ts'],
        affectedTaskIds: ['T001'],
        message: 'rpc-recovery-message-secret-29140',
        details: ['rpc-recovery-detail-secret-29140'],
        attempts: 3,
        maxAttempts: 3,
        selectedImplementerProfile: 'local-small',
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
      queueDepth: 0,
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'status',
        data: {
          sessionId: 'session-1',
          phase: 'planning',
          state: null,
          question: '[transcript omitted]',
          issue: {
            id: 'rec-rpc-1',
            reason: 'retry-exhausted',
            phase: 'implementing',
            status: 'awaiting-user',
            taskId: 'T001',
            taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
            files: ['src/target.ts'],
            affectedTaskIds: ['T001'],
            message: TRANSCRIPT_OMITTED_MESSAGE,
            details: [TRANSCRIPT_OMITTED_MESSAGE],
            attempts: 3,
            maxAttempts: 3,
            selectedImplementerProfile: 'local-small',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
          queueDepth: 0,
          transcript: '[transcript omitted]',
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-message-secret-29140');
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-detail-secret-29140');
    expect(JSON.stringify(lines)).not.toContain('rpc-recovery-task-secret-29140');
  });

  it('projects cost approval status predictions when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });
    const sentinel = 'rpc-cost-prediction-secret-68142';

    writer.status({
      pending: 'cost_approval',
      prediction: {
        estimatedTasks: 1,
        lowCost: 0.01,
        expectedCost: 0.02,
        highCost: 0.03,
        plannerTool: 'planner',
        implementerTool: 'worker',
        deterministic: {
          estimateScope: 'prompt-input-only',
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextDetected: 0,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 1,
            priceUnknown: 0,
            profileUnavailable: 0,
          },
          tasks: [
            {
              taskId: taskId('T001'),
              title: `cost title ${sentinel}`,
              estimatedPromptTokens: 100,
              selectedProfileId: 'local-small',
              contextFit: 'fits',
              contextConfidence: 'context-explicit',
              priceConfidence: 'price-known',
              estimatedImplementerCost: 0.01,
              hypotheticalPlannerCost: 0.02,
            },
          ],
          totals: {
            knownActualEstimate: 0.01,
            hypotheticalAllPlanner: 0.02,
            estimatedSavings: 0.01,
            unknownCostReason: [],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'completed',
          classification: 'risk',
          affectedTaskIds: ['T001'],
          reason: `reason ${sentinel}`,
          recommendedUserDecision: `decision ${sentinel}`,
        },
      },
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'status',
        data: expect.objectContaining({
          pending: 'cost_approval',
          prediction: expect.objectContaining({
            deterministic: expect.objectContaining({
              tasks: [expect.objectContaining({ title: TRANSCRIPT_OMITTED_MESSAGE })],
            }),
            plannerEstimateReview: expect.objectContaining({
              reason: TRANSCRIPT_OMITTED_MESSAGE,
              recommendedUserDecision: TRANSCRIPT_OMITTED_MESSAGE,
            }),
          }),
          transcript: TRANSCRIPT_OMITTED_MESSAGE,
        }),
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(sentinel);
  });

  it('projects user-edit conflict status when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });
    const rawPath = 'src/rpc-private-conflict.ts';

    writer.status({
      pending: 'user_edit_conflict',
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
    });

    const lines = parseJsonLines(chunks);
    expect(lines).toEqual([
      {
        type: 'status',
        data: {
          pending: 'user_edit_conflict',
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
          transcript: TRANSCRIPT_OMITTED_MESSAGE,
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(rawPath);
  });

  it('summarizes sensitive errors when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });

    writer.error('Invalid JSON: {"type":"message","text":"rpc-private-frame"}', {
      transcriptSensitive: true,
      summary: 'Invalid RPC frame.',
    });

    expect(parseJsonLines(chunks)).toEqual([{ type: 'error', error: 'Invalid RPC frame.' }]);
    expect(JSON.stringify(parseJsonLines(chunks))).not.toContain('rpc-private-frame');
  });

  it('projects slash ACK command text and messages when transcript persistence is disabled', () => {
    const { chunks, stream } = createCaptureStream();
    const writer = createResponseWriter({
      stream,
      onClose: () => {},
      getPersistTranscript: () => false,
    });
    const rawPath = '/Users/example/project/private-attachment.png';

    writer.ack('slash', {
      command: `/attach ${rawPath}`,
      messages: [`Attached: ${rawPath}`],
    });

    expect(parseJsonLines(chunks)).toEqual([
      {
        type: 'ack',
        command: 'slash',
        data: {
          command: '/attach',
          messages: [TRANSCRIPT_OMITTED_MESSAGE],
        },
      },
    ]);
    expect(JSON.stringify(parseJsonLines(chunks))).not.toContain(rawPath);
  });
});
