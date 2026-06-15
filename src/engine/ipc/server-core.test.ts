import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createConnection, type Socket } from 'node:net';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { startIpcServer, type IpcServer } from './server.js';
import type { ServerMessage } from './protocol.js';

const AUTH_TOKEN = 'test-auth-token';

function readLines(socket: Socket, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerMessage[] = [];
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed) as ServerMessage);
        } catch {
          reject(new Error(`Failed to parse: ${trimmed}`));
          return;
        }
        if (messages.length >= count) {
          socket.removeListener('data', onData);
          resolve(messages);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

function connectClient(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function connectAndAuth(sockPath: string): Promise<Socket> {
  const socket = await connectClient(sockPath);
  sockets.push(socket);
  socket.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
  const msgs = await readLines(socket, 1);
  const meta = msgs[0]!;
  if (meta.kind !== 'session_meta') throw new Error('expected session_meta');
  await tick();
  return socket;
}

async function waitForEvent(
  bus: ReturnType<typeof createEventBus>,
  type: EngineEvent['type'],
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const unsub = bus.subscribe((e) => {
      if (e.type === type) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

const servers: IpcServer[] = [];
const tmpDirs: string[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    if (!s.destroyed) s.destroy();
  }
  for (const srv of servers.splice(0)) {
    await srv.close().catch(() => undefined);
  }
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

async function makeServer(overrides?: Partial<Parameters<typeof startIpcServer>[0]>) {
  const tmpDir = createTempDir('ipc-test');
  tmpDirs.push(tmpDir);
  const bus = createEventBus();
  const onUserInput = vi.fn();
  const srv = await startIpcServer({
    sessionId: 'test-session',
    sessionDir: tmpDir,
    startedAt: 1000,
    mode: 'standard',
    feature: 'test feature',
    authToken: AUTH_TOKEN,
    bus,
    onUserInput,
    ...overrides,
  });
  servers.push(srv);
  return { srv, bus, onUserInput, tmpDir };
}

describe('startIpcServer', () => {
  it('creates socket file after bind', async () => {
    const { srv } = await makeServer();
    expect(existsSync(srv.sockPath)).toBe(true);
  });

  it('publishes ipc_server_started after bind', async () => {
    const events: EngineEvent[] = [];
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const srv = await startIpcServer({
      sessionId: 'sess1',
      sessionDir: tmpDir,
      startedAt: 1000,
      mode: 'quick',
      feature: 'feat',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);
    const started = events.find((e) => e.type === 'ipc_server_started');
    expect(started).toBeDefined();
    expect((started as Extract<EngineEvent, { type: 'ipc_server_started' }>).sockPath).toBe(
      srv.sockPath,
    );
  });

  it('sends session_meta after client authentication', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    socket.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('session_meta');
    if (msg.kind === 'session_meta') {
      expect(msg.sessionId).toBe('test-session');
      expect(msg.feature).toBe('test feature');
      expect(msg.mode).toBe('standard');
      expect(msg.startedAt).toBe(1000);
    }
  });

  it('rejects authentication with a wrong token and closes the socket', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    socket.write(
      JSON.stringify({ kind: 'authenticate', token: `${AUTH_TOKEN}-extra-bytes` }) + '\n',
    );

    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('error');
    if (msg.kind === 'error') {
      expect(msg.code).toBe('unauthorized');
      expect(msg.message).toBe('IPC: invalid auth token');
    }

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it('publishes ipc_client_attached when client connects', async () => {
    const { srv, bus } = await makeServer();
    const attachedPromise = waitForEvent(bus, 'ipc_client_attached');
    await connectAndAuth(srv.sockPath);
    await attachedPromise;
  });

  it('forwards bus events as { kind: event, payload } messages', async () => {
    const { srv, bus } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    const linesPromise = readLines(socket, 1);
    bus.publish({ type: 'workflow_started', ts: 123, phase: 'idle', feature: 'x' });
    const eventMsgs = await linesPromise;
    const msg = eventMsgs[0]!;

    expect(msg.kind).toBe('event');
    if (msg.kind === 'event') {
      expect(msg.payload.type).toBe('workflow_started');
    }
  });

  it('rejects second connection with already_attached', async () => {
    const { srv } = await makeServer();

    const s1 = await connectAndAuth(srv.sockPath);

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    const rejectMsgs = await readLines(s2, 1);
    const rejectMsg = rejectMsgs[0]!;
    expect(rejectMsg.kind).toBe('error');
    if (rejectMsg.kind === 'error') {
      expect(rejectMsg.code).toBe('already_attached');
    }

    await waitForClose(s2);
    expect(s2.destroyed).toBe(true);
    expect(s1.destroyed).toBe(false);
  });

  it('rejects unauthenticated detach from a second connection', async () => {
    const { srv } = await makeServer();
    const s1 = await connectAndAuth(srv.sockPath);

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    s2.write(JSON.stringify({ kind: 'detach' }) + '\n');

    const rejectMsgs = await readLines(s2, 1);
    const rejectMsg = rejectMsgs[0]!;
    expect(rejectMsg.kind).toBe('error');
    if (rejectMsg.kind === 'error') {
      expect(rejectMsg.code).toBe('unauthorized');
    }

    await waitForClose(s2);
    expect(s1.destroyed).toBe(false);
  });

  it('allows authenticated detach from a second connection', async () => {
    const { srv } = await makeServer();
    const s1 = await connectAndAuth(srv.sockPath);

    const victimFrames: ServerMessage[] = [];
    let victimClosed = false;
    let frameArrivedBeforeClose = false;
    let victimBuf = '';
    s1.on('data', (chunk: Buffer) => {
      victimBuf += chunk.toString('utf8');
      const lines = victimBuf.split('\n');
      victimBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const frame = JSON.parse(trimmed) as ServerMessage;
        victimFrames.push(frame);
        if (frame.kind === 'error' && !victimClosed) frameArrivedBeforeClose = true;
      }
    });
    s1.on('close', () => {
      victimClosed = true;
    });

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    s2.write(
      `${JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN })}\n${JSON.stringify({
        kind: 'detach',
      })}\n`,
    );

    await waitForClose(s1);
    await waitForClose(s2);
    expect(s1.destroyed).toBe(true);

    const terminalFrame = victimFrames.find((f) => f.kind === 'error');
    expect(terminalFrame).toBeDefined();
    if (terminalFrame?.kind === 'error') {
      expect(terminalFrame.code).toBe('already_attached');
    }
    expect(frameArrivedBeforeClose).toBe(true);
  });

  it('reassembles a multibyte auth token split across frames in the detach handshake', async () => {
    const token = 'トークン値';
    const { srv } = await makeServer({ authToken: token });
    const s1 = await connectClient(srv.sockPath);
    sockets.push(s1);
    s1.write(JSON.stringify({ kind: 'authenticate', token }) + '\n');
    const meta = await readLines(s1, 1);
    if (meta[0]!.kind !== 'session_meta') throw new Error('expected session_meta');

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    const handshake = Buffer.from(
      `${JSON.stringify({ kind: 'authenticate', token })}\n${JSON.stringify({ kind: 'detach' })}\n`,
      'utf8',
    );
    // Split inside the first multibyte character of the token.
    const at = handshake.indexOf(Buffer.from(token, 'utf8')[0]!) + 1;
    s2.write(handshake.subarray(0, at));
    await tick();
    s2.write(handshake.subarray(at));

    await waitForClose(s1);
    expect(s1.destroyed).toBe(true);
  });

  it('delivers user_input text when a client sends it', async () => {
    const { srv, onUserInput } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    socket.write(JSON.stringify({ kind: 'user_input', text: 'hello world' }) + '\n');
    await tick();
    await tick();
    expect(onUserInput).toHaveBeenCalledWith('hello world');
  });

  it('reassembles multibyte user_input split across socket frames', async () => {
    const { srv, onUserInput } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    // The payload contains '日本語', a multibyte string. Splitting the encoded frame mid-character
    // must not corrupt it: the server socket buffers the partial sequence across data events.
    const frame = Buffer.from(
      JSON.stringify({ kind: 'user_input', text: '日本語' }) + '\n',
      'utf8',
    );
    // Byte 30 lands inside the first multibyte character ('日' occupies bytes 29-31).
    const split = 30;
    socket.write(frame.subarray(0, split));
    await tick();
    socket.write(frame.subarray(split));
    await tick();
    await tick();

    expect(onUserInput).toHaveBeenCalledWith('日本語');
  });

  it('ignores user_input messages without string text', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus, onUserInput } = await makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await connectAndAuth(srv.sockPath);

    socket.write(JSON.stringify({ kind: 'user_input', text: { value: 'not text' } }) + '\n');
    await tick();
    await tick();

    expect(onUserInput).not.toHaveBeenCalled();
    expect(
      events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure')),
    ).toBe(true);
  });

  it('sends pending prompt requests when a client attaches and resolves prompt_response', async () => {
    const { srv, bus } = await makeServer();

    const waiting = waitForEvent(bus, 'warning');
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
    await tick();
    expect(settled).toBe(false);

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    socket.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
    const allMsgs = await readLines(socket, 2);
    const meta = allMsgs.find((msg) => msg.kind === 'session_meta');
    const prompt = allMsgs.find((msg) => msg.kind === 'prompt_request');
    if (meta?.kind !== 'session_meta') throw new Error('missing session_meta');
    await tick();

    expect(prompt).toBeDefined();
    if (prompt?.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(prompt.request.kind).toBe('approval_needed');

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
    const { srv, bus } = await makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await connectAndAuth(srv.sockPath);

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
    const msgs = await readLines(socket, 1);
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
    await tick();
    await tick();

    expect(settled).toBe(false);
    expect(
      events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure')),
    ).toBe(true);
  });

  it('fails closed for no-client prompts when configured for explicit headless mode', async () => {
    const { srv } = await makeServer({ noClientPromptBehavior: 'fail-closed' });

    await expect(
      srv.requestClientPrompt({
        kind: 'approval_needed',
        approvalType: 'briefs',
        filePath: '/tmp/briefs.md',
      }),
    ).rejects.toMatchObject({
      kind: 'ipc-prompt-no-client-headless',
      data: { promptKind: 'approval_needed' },
      message:
        'IPC prompt cannot be answered in explicit headless mode without an attached client: approval_needed',
    });
  });

  it('keeps a human prompt pending while a client is attached and resolves only on response', async () => {
    const { srv } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

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

    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    await tick();
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
    const { srv } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'question_asked',
      question: { id: 'q1', type: 'input', text: 'Which option?' },
      num: 1,
      total: 3,
    });
    const msgs = await readLines(socket, 1);
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
    const { srv } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'tiered_approval',
      request: {
        tier: 'confirm',
        actionClass: 'destructive',
        actionDescription: 'knex migrate',
        phase: 'implementing',
      },
    });
    const msgs = await readLines(socket, 1);
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
    const { srv } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);

    const promptPromise = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
    });
    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(msg.request).toMatchObject({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/tasks.md',
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

  it('handles detach: closes client socket, server stays up', async () => {
    const { srv } = await makeServer();

    const s1 = await connectAndAuth(srv.sockPath);

    s1.write(JSON.stringify({ kind: 'detach' }) + '\n');
    await waitForClose(s1);
    expect(s1.destroyed).toBe(true);

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    s2.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
    const afterDetachMsgs = await readLines(s2, 1);
    expect(afterDetachMsgs[0]!.kind).toBe('session_meta');
  });

  it('publishes ipc_client_detached on client disconnect', async () => {
    const { srv, bus } = await makeServer();

    const socket = await connectAndAuth(srv.sockPath);
    await tick();

    const detachedPromise = waitForEvent(bus, 'ipc_client_detached');
    socket.destroy();
    await detachedPromise;
  });

  it('publishes ipc_client_detached on detach command', async () => {
    const { srv, bus } = await makeServer();

    const socket = await connectAndAuth(srv.sockPath);
    await tick();

    const detachedPromise = waitForEvent(bus, 'ipc_client_detached');
    socket.write(JSON.stringify({ kind: 'detach' }) + '\n');
    await detachedPromise;
    await waitForClose(socket);
  });

  it('does not publish ipc_client_detached for a client that never attached', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await makeServer();
    bus.subscribe((e) => events.push(e));

    // Wrong token: server writes an error, destroys the socket, and detaches before attaching.
    const badAuth = await connectClient(srv.sockPath);
    sockets.push(badAuth);
    badAuth.write(JSON.stringify({ kind: 'authenticate', token: 'wrong-token' }) + '\n');
    const badAuthMsgs = await readLines(badAuth, 1);
    expect(badAuthMsgs[0]!.kind).toBe('error');
    await waitForClose(badAuth);

    // Pre-auth command: rejected and socket destroyed without ever attaching.
    const preAuth = await connectClient(srv.sockPath);
    sockets.push(preAuth);
    preAuth.write(JSON.stringify({ kind: 'user_input', text: 'hi' }) + '\n');
    const preAuthMsgs = await readLines(preAuth, 1);
    expect(preAuthMsgs[0]!.kind).toBe('error');
    await waitForClose(preAuth);

    // Never-authenticated probe: just connect and close.
    const probe = await connectClient(srv.sockPath);
    sockets.push(probe);
    probe.destroy();
    await waitForClose(probe);
    await tick();

    expect(events.some((e) => e.type === 'ipc_client_attached')).toBe(false);
    expect(events.some((e) => e.type === 'ipc_client_detached')).toBe(false);
  });

  it('publishes warning on malformed JSON, does not crash', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await makeServer();
    bus.subscribe((e) => events.push(e));

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);

    socket.write('not valid json\n');
    await tick();
    await tick();

    expect(events.some((e) => e.type === 'warning')).toBe(true);
    expect(srv.sockPath).toBeTruthy();
    expect(existsSync(srv.sockPath)).toBe(true);
  });

  it('close() removes socket file', async () => {
    const { srv } = await makeServer();
    expect(existsSync(srv.sockPath)).toBe(true);
    await srv.close();
    expect(existsSync(srv.sockPath)).toBe(false);
    const idx = servers.indexOf(srv);
    if (idx !== -1) servers.splice(idx, 1);
  });

  it('close() sends server_complete to the attached client', async () => {
    const { srv } = await makeServer();
    const socket = await connectAndAuth(srv.sockPath);
    const closePromise = srv.close();
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for server_complete')),
        1000,
      );
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          messages.push(JSON.parse(trimmed) as ServerMessage);
        }
        if (messages.some((msg) => msg.kind === 'server_complete')) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve();
        }
      };
      socket.on('data', onData);
    });
    await closePromise;
    expect(messages.some((msg) => msg.kind === 'server_complete')).toBe(true);
    const idx = servers.indexOf(srv);
    if (idx !== -1) servers.splice(idx, 1);
  });
});
