import { describe, it, expect } from 'vitest';
import { Socket } from 'node:net';
import { createEventBus } from '../events/bus.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../runners/types.js';
import { createPromptTracker } from './prompt-tracker.js';
import { IPC_MAX_FRAME_BYTES, type ServerMessage } from './protocol.js';

describe('createPromptTracker artifact review', () => {
  it('fails closed without exposing immutable artifact text when no client is attached', async () => {
    const bus = createEventBus();
    const warnings: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'fail-closed',
      currentSocket: () => null,
      writeMessage: () => undefined,
    });

    const pending = tracker.requestClientPrompt({
      kind: 'artifact_review',
      review: {
        label: 'artifact-label-secret-42891',
        text: 'artifact-text-secret-42891',
      },
    });

    await expect(pending).rejects.toMatchObject({
      kind: 'ipc-prompt-no-client-headless',
      data: { promptKind: 'artifact_review' },
    });
    const rejected = await pending.catch((err: unknown) => err);
    expect(JSON.stringify(rejected)).not.toContain('artifact-label-secret-42891');
    expect(JSON.stringify(rejected)).not.toContain('artifact-text-secret-42891');
    expect(JSON.stringify(warnings)).not.toContain('artifact-label-secret-42891');
    expect(JSON.stringify(warnings)).not.toContain('artifact-text-secret-42891');
  });

  it('sends immutable artifact review text in a separate prompt frame', async () => {
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
      kind: 'artifact_review',
      review: {
        label: 'Custom planner artifact',
        text: '# candidate\nartifact-text-72451\n',
      },
    });
    pending.catch(() => undefined);

    expect(sent).toContainEqual({
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-1',
        kind: 'artifact_review',
        review: {
          label: 'Custom planner artifact',
          text: '# candidate\nartifact-text-72451\n',
        },
      },
    });

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'artifact_review',
        approved: false,
      }),
    ).toBe(true);
    await pending;
    socket.destroy();
  });

  it('re-delivers the exact immutable artifact review after a client reconnects', async () => {
    const bus = createEventBus();
    const sent: ServerMessage[] = [];
    const firstSocket = new Socket();
    const reconnectedSocket = new Socket();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => firstSocket,
      writeMessage: (_socket, message) => {
        sent.push(message);
      },
    });
    const request = {
      requestId: 'prompt-1',
      kind: 'artifact_review' as const,
      review: {
        label: 'Custom planner artifact',
        text: '\u0000artifact-text-95821\u001b[31m',
      },
    };

    const pending = tracker.requestClientPrompt({
      kind: 'artifact_review',
      review: request.review,
    });
    tracker.sendPendingPrompts(reconnectedSocket);

    expect(sent).toEqual([
      { kind: 'prompt_request', request },
      { kind: 'prompt_request', request },
    ]);
    expect(tracker.handleResponse('prompt-1', { kind: 'artifact_review', approved: true })).toBe(
      true,
    );
    await expect(pending).resolves.toEqual({ kind: 'artifact_review', approved: true });
    firstSocket.destroy();
    reconnectedSocket.destroy();
  });

  it('fails closed before sending or retaining an artifact review that exceeds its transport bounds', async () => {
    const bus = createEventBus();
    const sent: ServerMessage[] = [];
    const warnings: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'warning') warnings.push(event.message);
    });
    const socket = new Socket();
    const tracker = createPromptTracker({
      bus,
      noClientPromptBehavior: 'wait',
      currentSocket: () => socket,
      writeMessage: (_socket, message) => {
        sent.push(message);
      },
    });
    const text = `${'\u0000'.repeat(PLANNER_ARTIFACT_MAX_BYTES)}x`;

    const pending = tracker.requestClientPrompt({
      kind: 'artifact_review',
      review: { label: 'artifact-label-secret-64482', text },
    });

    await expect(pending).rejects.toMatchObject({
      kind: 'ipc-artifact-review-too-large',
      data: expect.objectContaining({ promptKind: 'artifact_review' }),
    });
    tracker.sendPendingPrompts(socket);
    expect(sent).toEqual([]);
    expect(tracker.handleResponse('prompt-1', { kind: 'artifact_review', approved: true })).toBe(
      false,
    );
    expect(JSON.stringify(warnings)).not.toContain('artifact-label-secret-64482');

    const frameTooLarge = tracker.requestClientPrompt({
      kind: 'artifact_review',
      review: {
        label: 'x'.repeat(IPC_MAX_FRAME_BYTES),
        text: 'artifact-text-secret-64482',
      },
    });
    await expect(frameTooLarge).rejects.toMatchObject({
      kind: 'ipc-artifact-review-too-large',
      data: expect.objectContaining({ promptKind: 'artifact_review' }),
    });
    tracker.sendPendingPrompts(socket);
    expect(sent).toEqual([]);
    expect(JSON.stringify(warnings)).not.toContain('artifact-text-secret-64482');
    socket.destroy();
  });

  it('settles artifact review prompts only from their boolean response', async () => {
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
      kind: 'artifact_review',
      review: { label: 'Custom planner artifact', text: '# candidate\n' },
    });
    pending.catch(() => undefined);

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'approval_needed',
        approved: true,
      }),
    ).toBe(false);
    expect(warnings).toContainEqual(expect.stringContaining('response kind mismatch'));

    expect(
      tracker.handleResponse('prompt-1', {
        kind: 'artifact_review',
        approved: false,
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ kind: 'artifact_review', approved: false });
  });
});
