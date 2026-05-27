import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createConnection, type Socket } from 'node:net';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { startIpcServer, type IpcServer } from './server.js';
import type { ServerMessage } from './protocol.js';

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
    if (socket.destroyed) { resolve(); return; }
    socket.once('close', resolve);
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForEvent(bus: ReturnType<typeof createEventBus>, type: EngineEvent['type'], timeoutMs = 1000): Promise<void> {
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
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);
    const started = events.find((e) => e.type === 'ipc_server_started');
    expect(started).toBeDefined();
    expect((started as Extract<EngineEvent, { type: 'ipc_server_started' }>).sockPath).toBe(srv.sockPath);
  });

  it('sends session_meta on client connect', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
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

  it('publishes ipc_client_attached when client connects', async () => {
    const { srv, bus } = await makeServer();
    const attachedPromise = waitForEvent(bus, 'ipc_client_attached');
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // wait for session_meta
    await attachedPromise;
  });

  it('forwards bus events as { kind: event, payload } messages', async () => {
    const { srv, bus } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // consume session_meta

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

    const s1 = await connectClient(srv.sockPath);
    sockets.push(s1);
    await readLines(s1, 1); // consume session_meta for s1

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

  it('calls onUserInput when client sends user_input', async () => {
    const { srv, onUserInput } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // session_meta

    socket.write(JSON.stringify({ kind: 'user_input', text: 'hello world' }) + '\n');
    await tick();
    await tick();
    expect(onUserInput).toHaveBeenCalledWith('hello world');
  });

  it('ignores user_input messages without string text', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus, onUserInput } = await makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1);

    socket.write(JSON.stringify({ kind: 'user_input', text: { value: 'not text' } }) + '\n');
    await tick();
    await tick();

    expect(onUserInput).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure'))).toBe(true);
  });

  it('sends pending prompt requests when a client attaches and resolves prompt_response', async () => {
    const { srv, bus } = await makeServer();

    const waiting = waitForEvent(bus, 'warning');
    let settled = false;
    const promptPromise = srv.requestClientPrompt({
      kind: 'external_changes',
    });
    promptPromise.finally(() => {
      settled = true;
    }).catch(() => undefined);
    await waiting;
    await tick();
    expect(settled).toBe(false);

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    const msgs = await readLines(socket, 2);
    const prompt = msgs.find((msg) => msg.kind === 'prompt_request');

    expect(prompt).toBeDefined();
    if (prompt?.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(prompt.request.kind).toBe('external_changes');

    socket.write(JSON.stringify({
      kind: 'prompt_response',
      requestId: prompt.request.requestId,
      response: { kind: 'external_changes', proceed: true },
    }) + '\n');

    await expect(promptPromise).resolves.toEqual({ kind: 'external_changes', proceed: true });
  });

  it('ignores prompt_response messages with invalid response payloads', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1);

    let settled = false;
    const promptPromise = srv.requestClientPrompt({ kind: 'external_changes' });
    promptPromise.finally(() => {
      settled = true;
    }).catch(() => undefined);
    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');

    socket.write(JSON.stringify({
      kind: 'prompt_response',
      requestId: msg.request.requestId,
      response: { kind: 'external_changes', proceed: 'yes' },
    }) + '\n');
    await tick();
    await tick();

    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure'))).toBe(true);
  });

  it('fails closed for no-client prompts when configured for explicit headless mode', async () => {
    const { srv } = await makeServer({ noClientPromptBehavior: 'fail-closed' });

    await expect(srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: '/tmp/briefs.md',
    })).rejects.toMatchObject({
      kind: 'ipc-prompt-no-client-headless',
      code: 'ipc_prompt_no_client_headless',
      promptKind: 'approval_needed',
      data: { promptKind: 'approval_needed' },
      message: 'IPC prompt cannot be answered in explicit headless mode without an attached client: approval_needed',
    });
  });

  it('rejects prompt promises after 30s timeout', async () => {
    vi.useFakeTimers();
    try {
      const { srv } = await makeServer();
      const promptPromise = srv.requestClientPrompt({ kind: 'external_changes' });
      vi.advanceTimersByTime(30_000);
      await expect(promptPromise).rejects.toThrow('IPC prompt timed out after 30s: external_changes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends prompt requests immediately to an attached client', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1);

    const promptPromise = srv.requestClientPrompt({
      kind: 'budget_paused',
      currentCost: 8.5,
      maxBudget: 10,
    });
    const msgs = await readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('prompt_request');
    if (msg.kind !== 'prompt_request') throw new Error('missing prompt_request');
    expect(msg.request).toMatchObject({ kind: 'budget_paused', currentCost: 8.5, maxBudget: 10 });

    socket.write(JSON.stringify({
      kind: 'prompt_response',
      requestId: msg.request.requestId,
      response: { kind: 'budget_paused', decision: 'continue' },
    }) + '\n');

    await expect(promptPromise).resolves.toEqual({ kind: 'budget_paused', decision: 'continue' });
  });

  it('round-trips tiered approval prompts through an attached client', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1);

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

    socket.write(JSON.stringify({
      kind: 'prompt_response',
      requestId: msg.request.requestId,
      response: {
        kind: 'tiered_approval',
        response: { decision: 'confirm', phrase: 'I confirm', reason: 'running migration' },
      },
    }) + '\n');

    await expect(promptPromise).resolves.toEqual({
      kind: 'tiered_approval',
      response: { decision: 'confirm', phrase: 'I confirm', reason: 'running migration' },
    });
  });

  it('round-trips approval edit actions through an attached client', async () => {
    const { srv } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1);

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

    socket.write(JSON.stringify({
      kind: 'prompt_response',
      requestId: msg.request.requestId,
      response: {
        kind: 'approval_needed',
        approved: false,
        action: 'edit',
      },
    }) + '\n');

    await expect(promptPromise).resolves.toEqual({
      kind: 'approval_needed',
      approved: false,
      action: 'edit',
    });
  });

  it('handles detach: closes client socket, server stays up', async () => {
    const { srv } = await makeServer();

    const s1 = await connectClient(srv.sockPath);
    sockets.push(s1);
    await readLines(s1, 1); // session_meta

    s1.write(JSON.stringify({ kind: 'detach' }) + '\n');
    await waitForClose(s1);
    expect(s1.destroyed).toBe(true);

    const s2 = await connectClient(srv.sockPath);
    sockets.push(s2);
    const afterDetachMsgs = await readLines(s2, 1);
    expect(afterDetachMsgs[0]!.kind).toBe('session_meta');
  });

  it('publishes ipc_client_detached on client disconnect', async () => {
    const { srv, bus } = await makeServer();

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // session_meta
    await tick();

    const detachedPromise = waitForEvent(bus, 'ipc_client_detached');
    socket.destroy();
    await detachedPromise;
  });

  it('publishes ipc_client_detached on detach command', async () => {
    const { srv, bus } = await makeServer();

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // session_meta
    await tick();

    const detachedPromise = waitForEvent(bus, 'ipc_client_detached');
    socket.write(JSON.stringify({ kind: 'detach' }) + '\n');
    await detachedPromise;
    await waitForClose(socket);
  });

  it('publishes warning on malformed JSON, does not crash', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await makeServer();
    bus.subscribe((e) => events.push(e));

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);
    await readLines(socket, 1); // session_meta

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
});

function makeSessionLogLine(event: EngineEvent): string {
  const { type, ts, ...rest } = event;
  const phase = 'phase' in event ? (event as { phase: unknown }).phase : undefined;
  const taskId = 'taskId' in event ? (event as { taskId?: unknown }).taskId : undefined;
  const data = { ...rest };
  if ('phase' in data) delete (data as Record<string, unknown>)['phase'];
  if ('taskId' in data) delete (data as Record<string, unknown>)['taskId'];
  return JSON.stringify({
    kind: 'event',
    ts: new Date(ts).toISOString(),
    type,
    ...(phase !== undefined && { phase }),
    ...(taskId !== undefined && { taskId }),
    data,
  });
}

describe('startIpcServer replay', () => {
  it('client receives replay_meta before live events when sessionJsonlPath provided', async () => {
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const sessionJsonlPath = join(tmpDir, 'session.jsonl');
    const storedEvents: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'feat' },
      { type: 'workflow_complete', ts: 2000, phase: 'idle' },
    ];
    writeFileSync(sessionJsonlPath, storedEvents.map(makeSessionLogLine).join('\n') + '\n');

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'replay-test',
      sessionDir: tmpDir,
      startedAt: 1000,
      mode: 'standard',
      feature: 'feat',
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);

    const msgs = await readLines(socket, 6);

    expect(msgs[0]!.kind).toBe('session_meta');

    const replayStartedMsg = msgs[1]!;
    expect(replayStartedMsg.kind).toBe('event');
    if (replayStartedMsg.kind === 'event') {
      expect(replayStartedMsg.payload.type).toBe('replay_started');
    }

    const replayMeta = msgs[2]!;
    expect(replayMeta.kind).toBe('replay_meta');
    if (replayMeta.kind === 'replay_meta') {
      expect(replayMeta.totalEvents).toBe(2);
      expect(replayMeta.firstTs).toBe(1000);
      expect(replayMeta.lastTs).toBe(2000);
    }
  });

  it('replayed events arrive in order before replay_complete', async () => {
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const sessionJsonlPath = join(tmpDir, 'session.jsonl');
    const storedEvents: EngineEvent[] = [
      { type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' },
      { type: 'warning', ts: 200, phase: 'idle', message: 'a' },
      { type: 'warning', ts: 300, phase: 'idle', message: 'b' },
    ];
    writeFileSync(sessionJsonlPath, storedEvents.map(makeSessionLogLine).join('\n') + '\n');

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'order-test',
      sessionDir: tmpDir,
      startedAt: 100,
      mode: 'quick',
      feature: 'x',
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);

    const msgs = await readLines(socket, 7);

    const replayed = msgs.slice(3, 6);
    expect(replayed[0]!.kind).toBe('event');
    expect(replayed[1]!.kind).toBe('event');
    expect(replayed[2]!.kind).toBe('event');
    if (replayed[0]!.kind === 'event') expect(replayed[0]!.payload.type).toBe('workflow_started');
    if (replayed[1]!.kind === 'event') expect(replayed[1]!.payload.type).toBe('warning');
    if (replayed[2]!.kind === 'event') expect(replayed[2]!.payload.type).toBe('warning');

    const completeMsg = msgs[6]!;
    expect(completeMsg.kind).toBe('event');
    if (completeMsg.kind === 'event') {
      expect(completeMsg.payload.type).toBe('replay_complete');
      expect((completeMsg.payload as { totalEvents: number }).totalEvents).toBe(3);
    }
  });

  it('after replay, new bus events are forwarded to client', async () => {
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const sessionJsonlPath = join(tmpDir, 'session.jsonl');
    writeFileSync(sessionJsonlPath, makeSessionLogLine({ type: 'workflow_started', ts: 500, phase: 'idle', feature: 'y' }) + '\n');

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'live-test',
      sessionDir: tmpDir,
      startedAt: 500,
      mode: 'instant',
      feature: 'y',
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);

    await readLines(socket, 5);

    const livePromise = readLines(socket, 1);
    bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: 'live event' });
    const liveMsg = await livePromise;
    expect(liveMsg[0]!.kind).toBe('event');
    if (liveMsg[0]!.kind === 'event') {
      expect(liveMsg[0]!.payload.type).toBe('warning');
    }
  });

  it('when no sessionJsonlPath provided, live events arrive immediately after session_meta', async () => {
    const { srv, bus: testBus } = await makeServer();
    const socket = await connectClient(srv.sockPath);
    sockets.push(socket);

    await readLines(socket, 1);

    const liveP = readLines(socket, 1);
    testBus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: 'direct' });
    const live = await liveP;
    expect(live[0]!.kind).toBe('event');
    if (live[0]!.kind === 'event') {
      expect(live[0]!.payload.type).toBe('warning');
    }
  });
});
