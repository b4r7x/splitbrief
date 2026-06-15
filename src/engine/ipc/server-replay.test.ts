import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function readUntilReplayComplete(socket: Socket): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerMessage[] = [];
    let buf = '';
    let done = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(trimmed) as ServerMessage;
        } catch {
          reject(new Error(`Failed to parse: ${trimmed}`));
          return;
        }
        messages.push(msg);
        if (msg.kind === 'event' && msg.payload.type === 'replay_complete') {
          done = true;
          socket.removeListener('data', onData);
          resolve(messages);
          return;
        }
      }
      socket.pause();
      setTimeout(() => {
        if (!done && !socket.destroyed) socket.resume();
      }, 5);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

function readSlowlyUntil(
  socket: Socket,
  isLast: (msg: ServerMessage) => boolean,
): { sessionMeta: Promise<void>; messages: Promise<ServerMessage[]> } {
  let resolveSessionMeta: () => void = () => undefined;
  const sessionMeta = new Promise<void>((resolve) => {
    resolveSessionMeta = resolve;
  });
  const messages = new Promise<ServerMessage[]>((resolve, reject) => {
    const collected: ServerMessage[] = [];
    let buf = '';
    let done = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(trimmed) as ServerMessage;
        } catch {
          reject(new Error(`Failed to parse: ${trimmed}`));
          return;
        }
        collected.push(msg);
        if (msg.kind === 'session_meta') resolveSessionMeta();
        if (isLast(msg)) {
          done = true;
          socket.removeListener('data', onData);
          resolve(collected);
          return;
        }
      }
      socket.pause();
      setTimeout(() => {
        if (!done && !socket.destroyed) socket.resume();
      }, 5);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
  return { sessionMeta, messages };
}

function connectClient(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectAuthenticated(sockPath: string): Promise<Socket> {
  const socket = await connectClient(sockPath);
  sockets.push(socket);
  socket.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
  return socket;
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
  it('client receives replay_started carrying totalEvents before replayed events', async () => {
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
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectAuthenticated(srv.sockPath);

    const msgs = await readLines(socket, 5);

    expect(msgs[0]!.kind).toBe('session_meta');

    const replayStartedMsg = msgs[1]!;
    expect(replayStartedMsg.kind).toBe('event');
    if (replayStartedMsg.kind === 'event') {
      expect(replayStartedMsg.payload.type).toBe('replay_started');
      expect((replayStartedMsg.payload as { totalEvents: number }).totalEvents).toBe(2);
    }

    const kinds: string[] = msgs.map((m) => m.kind);
    expect(kinds).not.toContain('replay_meta');

    const firstReplayed = msgs[2]!;
    expect(firstReplayed.kind).toBe('event');
    if (firstReplayed.kind === 'event') {
      expect(firstReplayed.payload.type).toBe('workflow_started');
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
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectAuthenticated(srv.sockPath);

    const msgs = await readLines(socket, 6);

    const replayed = msgs.slice(2, 5);
    expect(replayed[0]!.kind).toBe('event');
    expect(replayed[1]!.kind).toBe('event');
    expect(replayed[2]!.kind).toBe('event');
    if (replayed[0]!.kind === 'event') expect(replayed[0]!.payload.type).toBe('workflow_started');
    if (replayed[1]!.kind === 'event') expect(replayed[1]!.payload.type).toBe('warning');
    if (replayed[2]!.kind === 'event') expect(replayed[2]!.payload.type).toBe('warning');

    const completeMsg = msgs[5]!;
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
    writeFileSync(
      sessionJsonlPath,
      makeSessionLogLine({ type: 'workflow_started', ts: 500, phase: 'idle', feature: 'y' }) + '\n',
    );

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'live-test',
      sessionDir: tmpDir,
      startedAt: 500,
      mode: 'instant',
      feature: 'y',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectAuthenticated(srv.sockPath);

    await readLines(socket, 4);

    const livePromise = readLines(socket, 1);
    bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: 'live event' });
    const liveMsg = await livePromise;
    expect(liveMsg[0]!.kind).toBe('event');
    if (liveMsg[0]!.kind === 'event') {
      expect(liveMsg[0]!.payload.type).toBe('warning');
    }
  });

  it('slow reader receives the entire large replay and replay_complete matches received count', async () => {
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const sessionJsonlPath = join(tmpDir, 'session.jsonl');

    const eventCount = 200;
    const padding = 'x'.repeat(5 * 1024);
    const storedEvents: EngineEvent[] = Array.from({ length: eventCount }, (_, i) => ({
      type: 'warning',
      ts: 1000 + i,
      phase: 'idle',
      message: `${i}:${padding}`,
    }));
    writeFileSync(sessionJsonlPath, storedEvents.map(makeSessionLogLine).join('\n') + '\n');

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'slow-reader-test',
      sessionDir: tmpDir,
      startedAt: 1000,
      mode: 'standard',
      feature: 'big',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectAuthenticated(srv.sockPath);

    const messages = await readUntilReplayComplete(socket);

    const replayWarnings = messages.filter(
      (m): m is Extract<ServerMessage, { kind: 'event' }> =>
        m.kind === 'event' && m.payload.type === 'warning',
    );
    expect(replayWarnings).toHaveLength(eventCount);
    for (let i = 0; i < eventCount; i++) {
      const payload = replayWarnings[i]!.payload as { message: string };
      expect(payload.message.startsWith(`${i}:`)).toBe(true);
    }

    const complete = messages.find(
      (m): m is Extract<ServerMessage, { kind: 'event' }> =>
        m.kind === 'event' && m.payload.type === 'replay_complete',
    );
    expect(complete).toBeDefined();
    expect((complete!.payload as { totalEvents: number }).totalEvents).toBe(replayWarnings.length);
  });

  it('keeps a same-ms live event buffered during replay and dedupes only true replay duplicates', async () => {
    const tmpDir = createTempDir('ipc-test');
    tmpDirs.push(tmpDir);
    const sessionJsonlPath = join(tmpDir, 'session.jsonl');

    const padding = 'x'.repeat(5 * 1024);
    const lastReplayedTs = 9000;
    const storedEvents: EngineEvent[] = [
      ...Array.from(
        { length: 200 },
        (_, i): EngineEvent => ({
          type: 'warning',
          ts: 1000 + i,
          phase: 'idle',
          message: `stored ${i}:${padding}`,
        }),
      ),
      { type: 'warning', ts: lastReplayedTs, phase: 'idle', message: 'last replayed line' },
    ];
    writeFileSync(sessionJsonlPath, storedEvents.map(makeSessionLogLine).join('\n') + '\n');

    const bus = createEventBus();
    const srv = await startIpcServer({
      sessionId: 'dedupe-test',
      sessionDir: tmpDir,
      startedAt: 1000,
      mode: 'standard',
      feature: 'dedupe',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: vi.fn(),
      sessionJsonlPath,
    });
    servers.push(srv);

    const socket = await connectAuthenticated(srv.sockPath);
    const { sessionMeta, messages: collected } = readSlowlyUntil(
      socket,
      (msg) =>
        msg.kind === 'event' &&
        msg.payload.type === 'warning' &&
        (msg.payload as { message: string }).message === 'live sentinel',
    );

    // session_meta is the first frame; the server has now subscribed to the bus
    // and is mid-replay, so these publishes land in the live backlog.
    await sessionMeta;

    // Same wall-clock ms as the last replayed line, but a genuinely new event.
    const sameMsLive: EngineEvent = {
      type: 'warning',
      ts: lastReplayedTs,
      phase: 'idle',
      message: 'new same-ms live event',
    };
    // Byte-identical to a replayed line: a true duplicate that must be dropped.
    const duplicateOfReplayed: EngineEvent = {
      type: 'warning',
      ts: lastReplayedTs,
      phase: 'idle',
      message: 'last replayed line',
    };
    const sentinel: EngineEvent = {
      type: 'warning',
      ts: lastReplayedTs + 1,
      phase: 'idle',
      message: 'live sentinel',
    };
    bus.publish(duplicateOfReplayed);
    bus.publish(sameMsLive);
    bus.publish(sentinel);

    const messages = await collected;
    const warnings = messages.filter(
      (m): m is Extract<ServerMessage, { kind: 'event' }> =>
        m.kind === 'event' && m.payload.type === 'warning',
    );
    const liveMessages = warnings
      .map((m) => (m.payload as { message: string }).message)
      .filter((message) => !message.startsWith('stored '));

    // The same-ms new event survives; the duplicate is dropped exactly once.
    expect(liveMessages).toEqual(['last replayed line', 'new same-ms live event', 'live sentinel']);
  });

  it('when no sessionJsonlPath provided, live events arrive immediately after session_meta', async () => {
    const { srv, bus: testBus } = await makeServer();
    const socket = await connectAuthenticated(srv.sockPath);

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
