import { describe, it, expect } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { createPromptTracker, ipcPromptError } from './prompt-tracker.js';
import { ipcServerError } from './server.js';

describe('ipcPromptError', () => {
  it('tags the close-cancellation with a domain kind', () => {
    const err = ipcPromptError.cancelledWhileClosing('approval_needed');
    expect(err.kind).toBe('ipc-prompt-cancelled-closing');
    expect(err.message).toBe('IPC prompt cancelled while closing server: approval_needed');
    expect(err.data).toEqual({ promptKind: 'approval_needed' });
  });
});

describe('ipcServerError', () => {
  it('tags the bind failure with a domain kind', () => {
    const err = ipcServerError.bindFailed('EADDRINUSE');
    expect(err.kind).toBe('ipc-server-bind-failed');
    expect(err.message).toBe('IPC server failed to bind: EADDRINUSE');
    expect(err.data).toEqual({ reason: 'EADDRINUSE' });
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
      data: { promptKind: 'approval_needed' },
      message:
        'IPC prompt cannot be answered in explicit headless mode without an attached client: approval_needed',
    });

    const rejected: Record<string, unknown> = await pending.catch(
      (err: unknown) => err as Record<string, unknown>,
    );
    expect(rejected.code).toBeUndefined();
    expect(rejected.promptKind).toBeUndefined();
  });
});
