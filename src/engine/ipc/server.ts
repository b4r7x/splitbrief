import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { ServerMessage, ClientMessage } from './protocol.js';
import { readReplayEvents } from './replay.js';

export type IpcServerOptions = {
  sessionId: string;
  sessionDir: string;
  startedAt: number;
  mode: WorkflowMode;
  feature: string;
  bus: EventBus;
  onUserInput: (text: string) => void;
  sessionJsonlPath?: string;
};

export type IpcServer = {
  readonly sockPath: string;
  close(): Promise<void>;
};

type ClientState = {
  socket: Socket;
  unsubscribe: () => void;
  buffer: string;
};

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const { sessionId, sessionDir, startedAt, mode, feature, bus, onUserInput, sessionJsonlPath } = opts;
  const sockPath = join(sessionDir, IPC_SOCK_FILE);

  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* ignore */ }
  }

  let currentClient: ClientState | null = null;
  // Array form is forward-looking for Phase B fan-out; Phase A enforces single client at line ~48.
  const allUnsubscribes: Array<() => void> = [];

  const server: Server = createServer((socket: Socket) => {
    void handleConnection(socket);
  });

  async function handleConnection(socket: Socket): Promise<void> {
    if (currentClient !== null) {
      const msg: ServerMessage = {
        kind: 'error',
        code: 'already_attached',
        message: 'session already has an attached client; use --force to steal',
      };
      socket.write(JSON.stringify(msg) + '\n');
      socket.destroy();
      return;
    }

    let detached = false;
    let replaying = true;
    const liveBacklog: EngineEvent[] = [];
    const client: ClientState = { socket, unsubscribe: () => undefined, buffer: '' };
    currentClient = client;

    function writeEvent(event: EngineEvent): void {
      if (socket.destroyed) return;
      const msg: ServerMessage = { kind: 'event', payload: event };
      try {
        socket.write(JSON.stringify(msg) + '\n');
      } catch {
        // socket may have closed mid-write; ignore
      }
    }

    function detachClient() {
      if (detached) return;
      detached = true;
      client.unsubscribe();
      const idx = allUnsubscribes.indexOf(client.unsubscribe);
      if (idx !== -1) allUnsubscribes.splice(idx, 1);
      if (currentClient?.socket === socket) {
        currentClient = null;
      }
      bus.publish({ type: 'ipc_client_detached', ts: Date.now(), phase: 'idle' });
    }

    socket.on('data', (chunk: Buffer) => {
      client.buffer += chunk.toString('utf8');
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(trimmed) as ClientMessage;
        } catch {
          bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: malformed JSON from client: ${trimmed}` });
          continue;
        }
        if (msg.kind === 'user_input') {
          try {
            onUserInput(msg.text);
          } catch (err) {
            bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: onUserInput threw: ${err instanceof Error ? err.message : String(err)}` });
          }
        } else if (msg.kind === 'detach') {
          detachClient();
          socket.destroy();
        }
      }
    });

    socket.on('close', () => {
      detachClient();
    });

    socket.on('error', (err) => {
      bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC client error: ${err.message}` });
      detachClient();
    });

    const meta: ServerMessage = { kind: 'session_meta', sessionId, startedAt, mode, feature, readonly: false };
    socket.write(JSON.stringify(meta) + '\n');

    bus.publish({ type: 'ipc_client_attached', ts: Date.now(), phase: 'idle' });

    const unsubscribe = bus.subscribe((event) => {
      if (socket.destroyed) return;
      if (replaying) {
        liveBacklog.push(event);
        return;
      }
      writeEvent(event);
    });
    client.unsubscribe = unsubscribe;
    allUnsubscribes.push(unsubscribe);

    if (sessionJsonlPath) {
      const replayStart = Date.now();
      const result = await readReplayEvents({ sessionJsonlPath });
      const { events: replayedEvents, count: totalEvents, firstTs, lastTs } = result;

      if (!socket.destroyed) {
        const startedMsg: ServerMessage = { kind: 'event', payload: { type: 'replay_started', ts: Date.now(), phase: 'idle', totalEvents } };
        socket.write(JSON.stringify(startedMsg) + '\n');
      }

      const replayMeta: ServerMessage = { kind: 'replay_meta', totalEvents, firstTs, lastTs };
      if (!socket.destroyed) {
        socket.write(JSON.stringify(replayMeta) + '\n');
      }

      for (const event of replayedEvents) {
        if (socket.destroyed) break;
        const msg: ServerMessage = { kind: 'event', payload: event };
        try {
          socket.write(JSON.stringify(msg) + '\n');
        } catch {
          // socket may have closed mid-replay; stop
          break;
        }
      }

      const durationMs = Date.now() - replayStart;
      const completeEvent = { type: 'replay_complete' as const, ts: Date.now(), phase: 'idle' as const, totalEvents, durationMs };
      if (!socket.destroyed) {
        const msg: ServerMessage = { kind: 'event', payload: completeEvent };
        socket.write(JSON.stringify(msg) + '\n');
      }
    }

    replaying = false;
    for (const event of liveBacklog.splice(0)) {
      writeEvent(event);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(`IPC server failed to bind: ${err.message}`));
    });
    server.listen(sockPath, () => {
      resolve();
    });
  });

  bus.publish({ type: 'ipc_server_started', ts: Date.now(), phase: 'idle', sockPath });

  return {
    sockPath,
    close(): Promise<void> {
      for (const unsub of allUnsubscribes) {
        try { unsub(); } catch { /* ignore */ }
      }
      allUnsubscribes.length = 0;

      if (currentClient) {
        try { currentClient.socket.destroy(); } catch { /* ignore */ }
        currentClient = null;
      }

      return new Promise<void>((resolve) => {
        server.close(() => {
          try { unlinkSync(sockPath); } catch { /* ignore ENOENT */ }
          resolve();
        });
      });
    },
  };
}
