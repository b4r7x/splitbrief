import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { allowedSettlingBriefReviewCommandsForPrompt } from '../../core/schemas/brief-review-command.js';
import type { EngineEvent } from '../events/types.js';
import { createIpcServerTestHarness } from '#testing/helpers/ipc-server.js';

describe('startIpcServer — prompts', () => {
  let harness: ReturnType<typeof createIpcServerTestHarness>;

  beforeEach(() => {
    harness = createIpcServerTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('sends pending prompt requests when a client attaches and resolves prompt_response', async () => {
    const { srv, bus } = await harness.makeServer();

    const waiting = harness.waitForEvent(bus, 'warning');
    let settled = false;
    const promptPromise = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    promptPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await waiting;
    await harness.tick();
    expect(settled).toBe(false);

    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);
    socket.write(JSON.stringify({ kind: 'authenticate', token: harness.authToken }) + '\n');
    const allMsgs = await harness.readLines(socket, 2);
    const meta = allMsgs.find((msg) => msg.kind === 'session_meta');
    const prompt = allMsgs.find((msg) => msg.kind === 'prompt_request');
    if (meta?.kind !== 'session_meta') throw new Error('missing session_meta');
    await harness.tick();

    expect(prompt).toBeDefined();
    if (prompt?.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(prompt.request.kind).toBe('approval_needed');
    expect(prompt.request).toMatchObject({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
      allowedCommands: [],
    });

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: prompt.request.requestId,
        response: { kind: 'approval_needed', approved: true },
      }) + '\n',
    );

    await expect(promptPromise).resolves.toEqual({ kind: 'approval_needed', approved: true });
  });

  it('ignores prompt_response messages with invalid response payloads', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await harness.makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await harness.connectAndAuth(srv.sockPath);

    let settled = false;
    const promptPromise = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    promptPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: msg.request.requestId,
        response: { kind: 'approval_needed', approved: 'yes' },
      }) + '\n',
    );
    await harness.tick();
    await harness.tick();

    expect(settled).toBe(false);
    expect(
      events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure')),
    ).toBe(true);
  });

  it('fails closed for no-client prompts when configured for explicit headless mode', async () => {
    const { srv } = await harness.makeServer({ noClientPromptBehavior: 'fail-closed' });

    await expect(
      srv.requestClientPrompt({
        kind: 'approval_needed',
        approvalType: 'briefs',
        filePath: '/tmp/briefs.md',
      }),
    ).rejects.toMatchObject({
      kind: 'ipc-prompt-no-client-headless',
      data: {
        promptKind: 'approval_needed',
        approvalType: 'briefs',
        artifactPath: '/tmp/briefs.md',
      },
      message:
        'IPC prompt cannot be answered in explicit headless mode without an attached client: approval_needed briefs artifact=/tmp/briefs.md',
    });
  });

  it('keeps a human prompt pending while a client is attached and resolves only on response', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    let settled = false;
    const promptPromise = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    promptPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    await harness.tick();
    expect(settled).toBe(false);

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: msg.request.requestId,
        response: { kind: 'approval_needed', approved: true },
      }) + '\n',
    );

    await expect(promptPromise).resolves.toEqual({ kind: 'approval_needed', approved: true });
  });

  it('sends prompt requests immediately to an attached client', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'question_asked',
      question: { id: 'q1', type: 'input', text: 'Which option?' },
      num: 1,
      total: 3,
    });
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(msg.request).toMatchObject({ kind: 'question_asked', num: 1, total: 3 });

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: msg.request.requestId,
        response: { kind: 'question_asked', answer: 'option A' },
      }) + '\n',
    );

    await expect(promptPromise).resolves.toEqual({ kind: 'question_asked', answer: 'option A' });
  });

  it('round-trips tiered approval prompts through an attached client', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'tiered_approval',
      request: {
        tier: 'confirm',
        actionClass: 'destructive',
        actionDescription: 'knex migrate',
        phase: 'implementing',
      },
    });
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(msg.request).toMatchObject({
      kind: 'tiered_approval',
      request: {
        tier: 'confirm',
        actionClass: 'destructive',
        actionDescription: 'knex migrate',
      },
    });

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: msg.request.requestId,
        response: {
          kind: 'tiered_approval',
          response: { decision: 'confirm', phrase: 'I confirm', reason: 'running migration' },
        },
      }) + '\n',
    );

    await expect(promptPromise).resolves.toEqual({
      kind: 'tiered_approval',
      response: { decision: 'confirm', phrase: 'I confirm', reason: 'running migration' },
    });
  });

  it('round-trips approval edit actions through an attached client', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
    });
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(msg.request).toMatchObject({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
      allowedCommands: [...allowedSettlingBriefReviewCommandsForPrompt('briefs')],
    });

    socket.write(
      JSON.stringify({
        kind: 'prompt_response',
        requestId: msg.request.requestId,
        response: {
          kind: 'approval_needed',
          approved: false,
          action: 'edit',
        },
      }) + '\n',
    );

    await expect(promptPromise).resolves.toEqual({
      kind: 'approval_needed',
      approved: false,
      action: 'edit',
    });
  });
});
