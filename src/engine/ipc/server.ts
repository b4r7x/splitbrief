import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { ServerMessage, ClientMessage, IpcPromptRequest, IpcPromptResponse, IpcPromptRequestInput } from './protocol.js';
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
  noClientPromptBehavior?: 'wait' | 'fail-closed';
};

export type IpcServer = {
  readonly sockPath: string;
  requestClientPrompt(request: IpcPromptRequestInput): Promise<IpcPromptResponse>;
  close(): Promise<void>;
};

export type IpcPromptUnavailableError = Error & {
  code: 'ipc_prompt_no_client_headless';
  promptKind: IpcPromptRequest['kind'];
};

type ClientState = {
  socket: Socket;
  unsubscribe: () => void;
  buffer: string;
};

type PendingPrompt = {
  request: IpcPromptRequest;
  resolve: (response: IpcPromptResponse) => void;
  reject: (err: Error) => void;
};

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const {
    sessionId,
    sessionDir,
    startedAt,
    mode,
    feature,
    bus,
    onUserInput,
    sessionJsonlPath,
    noClientPromptBehavior = 'wait',
  } = opts;
  const sockPath = join(sessionDir, IPC_SOCK_FILE);

  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* ignore */ }
  }

  let currentClient: ClientState | null = null;
  let nextPromptId = 1;
  const pendingPrompts = new Map<string, PendingPrompt>();
  // Array form is forward-looking for Phase B fan-out; Phase A enforces single client at line ~48.
  const allUnsubscribes: Array<() => void> = [];

  function writeMessage(socket: Socket, msg: ServerMessage): void {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch {
      // socket may have closed mid-write; ignore
    }
  }

  function sendPrompt(socket: Socket, request: IpcPromptRequest): void {
    writeMessage(socket, { kind: 'prompt_request', request });
  }

  function sendPendingPrompts(socket: Socket): void {
    for (const pending of pendingPrompts.values()) {
      sendPrompt(socket, pending.request);
    }
  }

  const server: Server = createServer((socket: Socket) => {
    void handleConnection(socket);
  });

  function createNoClientPromptError(request: IpcPromptRequest): IpcPromptUnavailableError {
    return Object.assign(
      new Error(`IPC prompt cannot be answered in explicit headless mode without an attached client: ${request.kind}`),
      {
        code: 'ipc_prompt_no_client_headless' as const,
        promptKind: request.kind,
      },
    );
  }

  function tryControlDetach(socket: Socket): void {
    let buffer = '';
    let consumed = false;
    const timer = setTimeout(() => {
      if (consumed) return;
      consumed = true;
      const msg: ServerMessage = {
        kind: 'error',
        code: 'already_attached',
        message: 'session already has an attached client; use --force to steal',
      };
      try { socket.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
      socket.destroy();
    }, 500);

    socket.on('data', (chunk: Buffer) => {
      if (consumed) return;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(trimmed) as ClientMessage;
        } catch {
          consumed = true;
          clearTimeout(timer);
          const errMsg: ServerMessage = {
            kind: 'error',
            code: 'already_attached',
            message: 'session already has an attached client; use --force to steal',
          };
          try { socket.write(JSON.stringify(errMsg) + '\n'); } catch { /* ignore */ }
          socket.destroy();
          return;
        }
        if (msg.kind === 'detach') {
          consumed = true;
          clearTimeout(timer);
          if (currentClient) {
            try { currentClient.socket.destroy(); } catch { /* ignore */ }
          }
          socket.destroy();
        } else {
          consumed = true;
          clearTimeout(timer);
          const errMsg: ServerMessage = {
            kind: 'error',
            code: 'already_attached',
            message: 'session already has an attached client; use --force to steal',
          };
          try { socket.write(JSON.stringify(errMsg) + '\n'); } catch { /* ignore */ }
          socket.destroy();
        }
        return;
      }
    });

    socket.on('error', () => {
      consumed = true;
      clearTimeout(timer);
      socket.destroy();
    });

    socket.on('close', () => {
      consumed = true;
      clearTimeout(timer);
    });
  }

  async function handleConnection(socket: Socket): Promise<void> {
    if (currentClient !== null) {
      // Allow second connection to send a control-channel `{kind:'detach'}` to
      // detach the current client, without rejecting outright. Anything else
      // (or no message within the grace window) is rejected as `already_attached`.
      tryControlDetach(socket);
      return;
    }

    let detached = false;
    let replaying = true;
    const liveBacklog: EngineEvent[] = [];
    const client: ClientState = { socket, unsubscribe: () => undefined, buffer: '' };
    currentClient = client;

    function writeEvent(event: EngineEvent): void {
      writeMessage(socket, { kind: 'event', payload: event });
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
        } else if (msg.kind === 'prompt_response') {
          const pending = pendingPrompts.get(msg.requestId);
          if (!pending) {
            bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: response for unknown prompt ${msg.requestId}` });
            continue;
          }
          pendingPrompts.delete(msg.requestId);
          pending.resolve(msg.response);
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

    writeMessage(socket, { kind: 'session_meta', sessionId, startedAt, mode, feature, readonly: false });

    bus.publish({ type: 'ipc_client_attached', ts: Date.now(), phase: 'idle' });
    sendPendingPrompts(socket);

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
        writeMessage(socket, { kind: 'event', payload: { type: 'replay_started', ts: Date.now(), phase: 'idle', totalEvents } });
      }

      const replayMeta: ServerMessage = { kind: 'replay_meta', totalEvents, firstTs, lastTs };
      if (!socket.destroyed) {
        writeMessage(socket, replayMeta);
      }

      for (const event of replayedEvents) {
        if (socket.destroyed) break;
        writeMessage(socket, { kind: 'event', payload: event });
      }

      const durationMs = Date.now() - replayStart;
      const completeEvent = { type: 'replay_complete' as const, ts: Date.now(), phase: 'idle' as const, totalEvents, durationMs };
      if (!socket.destroyed) {
        writeMessage(socket, { kind: 'event', payload: completeEvent });
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
    requestClientPrompt(requestWithoutId): Promise<IpcPromptResponse> {
      const request = {
        ...requestWithoutId,
        requestId: `prompt-${nextPromptId++}`,
      } as IpcPromptRequest;

      return new Promise<IpcPromptResponse>((resolve, reject) => {
        if (!currentClient && noClientPromptBehavior === 'fail-closed') {
          const err = createNoClientPromptError(request);
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: err.message,
          });
          reject(err);
          return;
        }

        pendingPrompts.set(request.requestId, { request, resolve, reject });
        if (currentClient) {
          sendPrompt(currentClient.socket, request);
        } else {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: `IPC prompt waiting for attached client: ${request.kind}`,
          });
        }
      });
    },
    close(): Promise<void> {
      for (const pending of pendingPrompts.values()) {
        pending.reject(new Error(`IPC prompt cancelled while closing server: ${pending.request.kind}`));
      }
      pendingPrompts.clear();

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
