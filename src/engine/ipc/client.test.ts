import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../events/types.js';
import type { ServerMessage } from './protocol.js';
import { createIpcConnection, handleServerMessage, type IpcClientState } from './client.js';

const servers: Server[] = [];
const clients: Socket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function sockPath(): string {
  return join(tmpdir(), `ipc-client-conn-${Math.random().toString(36).slice(2)}.sock`);
}

function startServer(onConnection: (socket: Socket) => void): Promise<string> {
  const path = sockPath();
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => onConnection(socket));
    servers.push(server);
    server.once('error', reject);
    server.listen(path, () => resolve(path));
  });
}

describe('createIpcConnection', () => {
  it('reassembles a server event frame whose multibyte payload is split across data chunks', async () => {
    const events: EngineEvent[] = [];
    const message = '日本語のメッセージ';
    let resolveExpectedWarning: () => void;
    const expectedWarning = new Promise<void>((resolve) => {
      resolveExpectedWarning = resolve;
    });

    const serverGotAuth = new Promise<void>((resolveAuth) => {
      void startServer((socket) => {
        socket.once('data', () => {
          const frame: ServerMessage = {
            kind: 'event',
            payload: { type: 'warning', ts: 1, phase: 'idle', message },
          };
          const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
          // Split inside the first multibyte character of the message body.
          const at = bytes.indexOf(Buffer.from(message, 'utf8')[0]!) + 1;
          socket.write(bytes.subarray(0, at));
          setTimeout(() => socket.write(bytes.subarray(at)), 10);
          resolveAuth();
        });
      }).then((path) => {
        const client = createIpcConnection({
          sockPath: path,
          authToken: 'token',
          callbacks: {
            setState: () => undefined,
            onEvent: (event) => {
              events.push(event);
              if (
                event.type === 'warning' &&
                (event as Extract<EngineEvent, { type: 'warning' }>).message === message
              ) {
                resolveExpectedWarning();
              }
            },
            hasPromptHandler: () => false,
            handlePromptRequest: () => Promise.reject(new Error('no prompt handler')),
            ownsSocket: () => true,
            canMutate: () => true,
            markDetached: () => undefined,
            resetAttempts: () => undefined,
          },
          onClose: () => undefined,
        });
        clients.push(client);
      });
    });

    await serverGotAuth;
    await expectedWarning;

    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect((warning as Extract<EngineEvent, { type: 'warning' }>).message).toBe(message);
  });
});

describe('handleServerMessage session_meta', () => {
  it('always sets status to connected', () => {
    let state: IpcClientState | null = null;
    const socket = { destroyed: false } as Socket;
    handleServerMessage(
      {
        kind: 'session_meta',
        sessionId: 'sess-1',
        startedAt: 1000,
        mode: 'standard',
        feature: 'test',
      },
      {
        socket,
        setState: (next) => {
          state = typeof next === 'function' ? next(state as IpcClientState) : next;
        },
        onEvent: () => undefined,
        hasPromptHandler: () => false,
        handlePromptRequest: () => Promise.reject(new Error('no prompt handler')),
        ownsSocket: () => true,
        canMutate: () => true,
        markDetached: () => undefined,
        resetAttempts: () => undefined,
      },
    );

    expect(state).toEqual({ status: 'connected', sessionId: 'sess-1' });
  });
});
