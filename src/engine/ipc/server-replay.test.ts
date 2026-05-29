import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
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
