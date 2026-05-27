import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { parseClientMessage, type IpcPromptRequestInput, type IpcPromptResponse } from './protocol.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { rejectAsAlreadyAttached, tryControlDetach } from './control-detach.js';
import { createPromptTracker, type IpcPromptUnavailableError } from './prompt-tracker.js';
import { replaySession, writeServerMessage } from './replay-session.js';

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

export type { IpcPromptUnavailableError };

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

  let currentClient: { socket: Socket; unsubscribe: () => void } | null = null;

  const server: Server = createServer((socket: Socket) => {
    void handleConnection(socket);
  });

  const promptTracker = createPromptTracker({
    bus,
    noClientPromptBehavior,
    currentSocket: () => currentClient?.socket ?? null,
    writeMessage: writeServerMessage,
  });

  async function handleConnection(socket: Socket): Promise<void> {
    if (currentClient !== null) {
      tryControlDetach({
        socket,
        currentSocket: () => currentClient?.socket ?? null,
        rejectAsAlreadyAttached: rejectSocket => rejectAsAlreadyAttached(rejectSocket, writeServerMessage),
      });
      return;
    }

    let detached = false;
    let replaying = true;
    const liveBacklog: EngineEvent[] = [];
    const client: { socket: Socket; unsubscribe: () => void } = { socket, unsubscribe: () => undefined };
    currentClient = client;

    function writeEvent(event: EngineEvent): void {
      writeServerMessage(socket, { kind: 'event', payload: event });
    }

    function detachClient() {
      if (detached) return;
      detached = true;
      client.unsubscribe();
      if (currentClient?.socket === socket) {
        currentClient = null;
      }
      bus.publish({ type: 'ipc_client_detached', ts: Date.now(), phase: 'idle' });
    }

    const lineBuffer = createLineBuffer((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: ReturnType<typeof parseClientMessage>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        msg = parseClientMessage(parsed);
        if (!msg) {
          bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: invalid message structure from client: ${trimmed}` });
          return;
        }
      } catch {
        bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: malformed JSON from client: ${trimmed}` });
        return;
      }
      if (msg.kind === 'user_input') {
        try {
          onUserInput(msg.text);
        } catch (err) {
          bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: onUserInput threw: ${toErrorMessage(err)}` });
        }
      } else if (msg.kind === 'prompt_response') {
        if (!promptTracker.handleResponse(msg.requestId, msg.response)) {
          bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC: response for unknown prompt ${msg.requestId}` });
        }
      } else if (msg.kind === 'detach') {
        detachClient();
        socket.destroy();
      }
    });

    socket.on('data', (chunk: Buffer) => {
      lineBuffer.push(chunk.toString('utf8'));
    });

    socket.on('close', () => {
      detachClient();
    });

    socket.on('error', (err) => {
      bus.publish({ type: 'warning', ts: Date.now(), phase: 'idle', message: `IPC client error: ${toErrorMessage(err)}` });
      detachClient();
    });

    writeServerMessage(socket, { kind: 'session_meta', sessionId, startedAt, mode, feature, readonly: false });

    bus.publish({ type: 'ipc_client_attached', ts: Date.now(), phase: 'idle' });
    promptTracker.sendPendingPrompts(socket);

    const unsubscribe = bus.subscribe((event) => {
      if (socket.destroyed) return;
      if (replaying) {
        liveBacklog.push(event);
        return;
      }
      writeEvent(event);
    });
    client.unsubscribe = unsubscribe;

    if (sessionJsonlPath) {
      await replaySession({ socket, sessionJsonlPath, writeMessage: writeServerMessage });
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
      return promptTracker.requestClientPrompt(requestWithoutId);
    },
    close(): Promise<void> {
      promptTracker.rejectAll(request => new Error(`IPC prompt cancelled while closing server: ${request.kind}`));

      if (currentClient) {
        try { currentClient.unsubscribe(); } catch { /* ignore */ }
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
