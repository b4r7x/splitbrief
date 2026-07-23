import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createConnection, type Socket } from 'node:net';
import { createEventBus } from '../../src/engine/events/bus.js';
import type { EngineEvent } from '../../src/engine/events/types.js';
import { startIpcServer, type IpcServer } from '../../src/engine/ipc/server.js';
import type { ServerMessage } from '../../src/engine/ipc/protocol.js';

export const IPC_TEST_AUTH_TOKEN = 'test-auth-token';

export interface IpcServerTestHarness {
  readonly authToken: string;
  servers: IpcServer[];
  tmpDirs: string[];
  sockets: Socket[];
  readLines(socket: Socket, count: number): Promise<ServerMessage[]>;
  connectClient(sockPath: string): Promise<Socket>;
  waitForClose(socket: Socket): Promise<void>;
  tick(): Promise<void>;
  connectAndAuth(sockPath: string): Promise<Socket>;
  waitForEvent(
    bus: ReturnType<typeof createEventBus>,
    type: EngineEvent['type'],
    timeoutMs?: number,
  ): Promise<void>;
  makeServer(overrides?: Partial<Parameters<typeof startIpcServer>[0]>): Promise<{
    srv: IpcServer;
    bus: ReturnType<typeof createEventBus>;
    onUserInput: ReturnType<typeof vi.fn>;
    tmpDir: string;
  }>;
  cleanup(): Promise<void>;
}

export function createIpcServerTestHarness(
  authToken: string = IPC_TEST_AUTH_TOKEN,
): IpcServerTestHarness {
  const servers: IpcServer[] = [];
  const tmpDirs: string[] = [];
  const sockets: Socket[] = [];

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
    socket.write(JSON.stringify({ kind: 'authenticate', token: authToken }) + '\n');
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
      authToken,
      bus,
      onUserInput,
      ...overrides,
    });
    servers.push(srv);
    return { srv, bus, onUserInput, tmpDir };
  }

  async function cleanup() {
    for (const s of sockets.splice(0)) {
      if (!s.destroyed) s.destroy();
    }
    for (const srv of servers.splice(0)) {
      await srv.close().catch(() => undefined);
    }
    for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
  }

  return {
    authToken,
    servers,
    tmpDirs,
    sockets,
    readLines,
    connectClient,
    waitForClose,
    tick,
    connectAndAuth,
    waitForEvent,
    makeServer,
    cleanup,
  };
}

export function ipcSocketExists(sockPath: string): boolean {
  return existsSync(sockPath);
}
