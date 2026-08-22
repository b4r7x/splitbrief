import { describe, it, expect } from 'vitest';
import { Socket } from 'node:net';
import {
  allowedSettlingBriefReviewCommandsForPrompt,
  BriefReviewCommandSchema,
  type BriefReviewCommand,
} from '../../core/schemas/brief-review-command.js';
import { taskId } from '../../core/schemas/task.js';
import { createEventBus } from '../events/bus.js';
import { createPromptTracker, ipcPromptError } from './prompt-tracker.js';
import type { ServerMessage } from './protocol.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const BRIEF_HASH = 'a'.repeat(64);

function briefCommand(overrides: Record<string, unknown> = {}): BriefReviewCommand {
  return BriefReviewCommandSchema.parse({
    version: 1,
    sessionId: 'session-1',
    epochId: 'epoch-1',
    operationId: 'operation-1',
    expectedBriefRevision: 2,
    expectedReportRevision: 2,
    intentHash: BRIEF_HASH,
    base: { revision: 2, hash: BRIEF_HASH, path: 'brief/tasks.md' },
    ...overrides,
  });
}

describe('ipcPromptError', () => {
  it('tags the close-cancellation with a domain kind', () => {
    const err = ipcPromptError.cancelledWhileClosing('approval_needed');
    expect(err.kind).toBe('ipc-prompt-cancelled-closing');
    expect(err.message).toBe('IPC prompt cancelled while closing server: approval_needed');
    expect(err.data).toEqual({ promptKind: 'approval_needed' });
  });
});

describe('createPromptTracker rejectAll', () => {
  it('rejects a pending prompt with a kind-tagged error', async () => {
    const bus = createEventBus();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    tracker.rejectAll((request) => ipcPromptError.cancelledWhileClosing(request.kind));

    await expect(pending).rejects.toMatchObject({
      kind: 'ipc-prompt-cancelled-closing',
      message: 'IPC prompt cancelled while closing server: approval_needed',
    });
  });
});

describe('createPromptTracker fail-closed', () => {
  it('rejects no-client prompts with a kind/data error carrying no bolted extras', async () => {
    const bus = createEventBus();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'fail-closed',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });

    await expect(pending).rejects.toMatchObject({
      kind: 'ipc-prompt-no-client-headless',
      data: {
        promptKind: 'approval_needed',
        approvalType: 'spec',
        artifactPath: '/tmp/spec.md',
      },
      message:
        'IPC prompt cannot be answered in explicit headless mode without an attached client: approval_needed spec artifact=/tmp/spec.md',
    });

    const rejected: Record<string, unknown> = await pending.catch(
      (err: unknown) => err as Record<string, unknown>,
    );
    expect(rejected.code).toBeUndefined();
    expect(rejected.promptKind).toBeUndefined();
  });
});

describe('createPromptTracker wait diagnostics', () => {
  it('adds prompt-scoped allowed commands to approval prompt frames', async () => {
    const bus = createEventBus();
    const sent: ServerMessage[] = [];
    const socket = new Socket();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => socket,
      writeMessage: (_socket, msg) => {
        sent.push(msg);
      },
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/session/tasks.md',
    });
    pending.catch(() => undefined);

    expect(sent).toContainEqual({
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-1',
        kind: 'approval_needed',
        approvalType: 'briefs',
        filePath: '/tmp/session/tasks.md',
        allowedCommands: [...allowedSettlingBriefReviewCommandsForPrompt('briefs')],
      },
    });

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        approved: false,
      }),
    ).toBe(true);
    await pending;
    socket.destroy();
  });

  it('replays the same pending prompt byte-equivalently after reconnect', async () => {
    const bus = createEventBus();
    const sent: ServerMessage[] = [];
    const firstSocket = new Socket();
    const reconnectedSocket = new Socket();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => firstSocket,
      writeMessage: (_socket, message) => sent.push(message),
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/session/tasks.md',
    });
    tracker.sendPendingPrompts(reconnectedSocket);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        command: briefCommand({ action: 'reject', userIntentId: 'reject-1' }),
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ kind: 'approval_needed', approved: false });
    firstSocket.destroy();
    reconnectedSocket.destroy();
  });

  it('publishes bounded approval artifact metadata while waiting for a client', async () => {
    const bus = createEventBus();
    const warnings: Array<Extract<Parameters<typeof bus.publish>[0], { type: 'warning' }>> = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event);
    });
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/session/tasks.md',
    });

    expect(warnings).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        category: 'ipc',
        code: 'prompt_waiting_for_client',
        transcriptSafe: true,
        message:
          'IPC prompt waiting for attached client: approval_needed briefs artifact=/tmp/session/tasks.md',
      }),
    );

    tracker.rejectAll((request) => ipcPromptError.cancelledWhileClosing(request.kind));
    await pending.catch(() => undefined);
  });
});

describe('createPromptTracker response validation', () => {
  it('rejects recovery actions that were not advertised by the pending prompt', async () => {
    const bus = createEventBus();
    const warnings: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'recovery_needed',
      issue: {
        id: 'rec-1',
        reason: 'retry-exhausted',
        phase: 'implementing',
        files: [],
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
      },
    });

    expect(
      tracker.handleResponse('prompt-1', { kind: 'recovery_needed', action: 'continue' }),
    ).toBe(false);
    expect(warnings).toContainEqual(expect.stringContaining('recovery action is not available'));
    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'recovery_needed',
        action: 'abort-workflow',
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'recovery_needed',
      action: 'abort-workflow',
    });
  });

  it('maps the canonical edit command to the existing approval edit response', async () => {
    const bus = createEventBus();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
    });

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        command: briefCommand({
          action: 'edit',
          briefText: 'updated brief',
          newInputId: 'input-2',
        }),
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'approval_needed',
      approved: false,
      action: 'edit',
    });
  });

  it('rejects the observation-only status command for a settling prompt', async () => {
    const bus = createEventBus();
    const warnings: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
    });
    pending.catch(() => undefined);

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        command: {
          version: 1,
          sessionId: 'session-1',
          epochId: 'epoch-1',
          action: 'status',
        },
      }),
    ).toBe(false);
    expect(warnings).toContainEqual(
      expect.stringContaining('Task Brief review command is not allowed for this prompt'),
    );

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        command: briefCommand({ action: 'approve' }),
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ kind: 'approval_needed', approved: true });
  });

  it('rejects task review responses outside the request-scoped command set', async () => {
    const bus = createEventBus();
    const warnings: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'task_review',
      request: {
        taskId: taskId('T001'),
        taskTitle: 'Review scoped command',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: makeUsage(),
        },
        availableCommands: ['continue'],
      },
    });
    pending.catch(() => undefined);

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'task_review',
        response: { action: 'abort' },
      }),
    ).toBe(false);
    expect(warnings).toContainEqual(expect.stringContaining('task review action is not available'));

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'task_review',
        response: { action: 'continue' },
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'task_review',
      response: { action: 'continue' },
    });
  });

  it('does not settle a newer prompt from a stale or duplicate response', async () => {
    const bus = createEventBus();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const stalePrompt = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    const newerPrompt = tracker.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'plan',
      filePath: '/tmp/plan.md',
    });

    expect(tracker.handleResponse('prompt-1', { kind: 'approval_needed', approved: false })).toBe(
      true,
    );
    await expect(stalePrompt).resolves.toEqual({ kind: 'approval_needed', approved: false });
    expect(tracker.handleResponse('prompt-1', { kind: 'approval_needed', approved: true })).toBe(
      false,
    );
    expect(tracker.handleResponse('prompt-2', { kind: 'approval_needed', approved: true })).toBe(
      true,
    );
    await expect(newerPrompt).resolves.toEqual({ kind: 'approval_needed', approved: true });
  });

  it('keeps protected recovery diagnostics free of operation payloads without a client', async () => {
    const bus = createEventBus();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'fail-closed',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });
    const pending = tracker.requestClientPrompt({
      kind: 'recovery_needed',
      issue: {
        id: 'operation-secret-17',
        reason: 'retry-exhausted',
        phase: 'implementing',
        files: [],
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
      },
    });

    const rejected = await pending.catch((error: unknown) => error);
    expect(JSON.stringify(rejected)).not.toContain('operation-secret-17');
  });
});
