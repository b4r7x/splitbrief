import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { ipcSockPath } from '../../core/paths.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import {
  parseClientMessage,
  IPC_MAX_FRAME_BYTES,
  type IpcPromptRequestInput,
  type IpcPromptResponse,
  type ServerMessage,
} from './protocol.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { rejectAsAlreadyAttached, tokensMatch, tryControlDetach } from './control-detach.js';
import { createPromptTracker, ipcPromptError } from './prompt-tracker.js';
import { error } from '../../utils/error.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { replaySession } from './replay-session.js';
import { writeServerMessage } from './write-message.js';

export type IpcServerOptions = {
  sessionId: string;
  sessionDir: string;
  startedAt: number;
  mode: WorkflowMode;
  feature: string;
  authToken: string;
  bus: EventBus;
  onUserInput: (text: string) => void;
  sessionJsonlPath?: string;
  noClientPromptBehavior?: 'wait' | 'fail-closed';
  persistTranscript?: boolean | undefined;
};

export type IpcServer = {
  readonly sockPath: string;
  requestClientPrompt(request: IpcPromptRequestInput): Promise<IpcPromptResponse>;
  close(): Promise<void>;
};

const MAX_LIVE_BACKLOG_EVENTS = 1000;

function eventIdentity(event: EngineEvent): string {
  return canonicalJSON(event);
}

export const ipcServerError = {
  bindFailed: (reason: string) =>
    error('ipc-server-bind-failed', `IPC server failed to bind: ${reason}`, { reason }),
} as const;

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const {
    sessionId,
    sessionDir,
    startedAt,
    mode,
    feature,
    authToken,
    bus,
    onUserInput,
    sessionJsonlPath,
    noClientPromptBehavior = 'wait',
    persistTranscript = true,
  } = opts;
  const sockPath = ipcSockPath(sessionDir);
  const writeMessage = (socket: Socket, msg: ServerMessage) =>
    writeServerMessage(socket, msg, { persistTranscript });

  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }

  let currentClient: { socket: Socket; unsubscribe: () => void } | null = null;

  const server: Server = createServer((socket: Socket) => {
    void handleConnection(socket);
  });

  const promptTracker = createPromptTracker({
    bus,
    noClientPromptBehavior,
    currentSocket: () => currentClient?.socket ?? null,
    writeMessage,
  });

  async function handleConnection(socket: Socket): Promise<void> {
    if (currentClient !== null) {
      tryControlDetach({
        socket,
        authToken,
        currentSocket: () => currentClient?.socket ?? null,
        rejectAsAlreadyAttached: (rejectSocket) =>
          rejectAsAlreadyAttached(rejectSocket, writeMessage),
        writeMessage,
      });
      return;
    }

    let detached = false;
    let authenticated = false;
    let replaying = true;
    const replayedIdentities = new Set<string>();
    let replayStarted = false;
    const liveBacklog: EngineEvent[] = [];
    const client: { socket: Socket; unsubscribe: () => void } = {
      socket,
      unsubscribe: () => undefined,
    };

    function writeEvent(event: EngineEvent): void {
      writeMessage(socket, { kind: 'event', payload: event });
    }

    function detachClient() {
      if (detached) return;
      detached = true;
      client.unsubscribe();
      if (currentClient?.socket !== socket) return;
      currentClient = null;
      bus.publish({ type: 'ipc_client_detached', ts: Date.now(), phase: 'idle' });
    }

    async function startAuthenticatedSession(): Promise<void> {
      if (replayStarted || detached || socket.destroyed) return;
      replayStarted = true;

      if (currentClient !== null) {
        rejectAsAlreadyAttached(socket, writeMessage);
        socket.destroy();
        detached = true;
        return;
      }

      currentClient = client;

      writeMessage(socket, {
        kind: 'session_meta',
        sessionId,
        startedAt,
        mode,
        feature,
      });

      bus.publish({ type: 'ipc_client_attached', ts: Date.now(), phase: 'idle' });
      promptTracker.sendPendingPrompts(socket);

      const unsubscribe = bus.subscribe((event) => {
        if (socket.destroyed) return;
        if (replaying) {
          if (liveBacklog.length >= MAX_LIVE_BACKLOG_EVENTS) {
            const warning: EngineEvent = {
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: 'IPC: live backlog exceeded while replaying, closing client',
            };
            replaying = false;
            detachClient();
            socket.destroy();
            bus.publish(warning);
            return;
          }
          liveBacklog.push(event);
          return;
        }
        writeEvent(event);
      });
      client.unsubscribe = unsubscribe;

      if (sessionJsonlPath) {
        try {
          const replayed = await replaySession({
            socket,
            sessionJsonlPath,
            writeMessage,
          });
          for (const event of replayed) replayedIdentities.add(eventIdentity(event));
        } catch (err) {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: `IPC: replay failed, closing client: ${toErrorMessage(err)}`,
          });
          replaying = false;
          detachClient();
          socket.destroy();
          return;
        }
      }

      replaying = false;
      for (const event of liveBacklog.splice(0)) {
        if (replayedIdentities.delete(eventIdentity(event))) continue;
        writeEvent(event);
      }
    }

    const lineBuffer = createLineBuffer(
      (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: ReturnType<typeof parseClientMessage>;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          msg = parseClientMessage(parsed);
          if (!msg) {
            bus.publish({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: `IPC: invalid message structure from client: ${trimmed}`,
            });
            return;
          }
        } catch {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: `IPC: malformed JSON from client: ${trimmed}`,
          });
          return;
        }

        if (msg.kind === 'authenticate') {
          if (!tokensMatch(msg.token, authToken)) {
            writeMessage(socket, {
              kind: 'error',
              code: 'unauthorized',
              message: 'IPC: invalid auth token',
            });
            socket.destroy();
            detachClient();
            return;
          }
          authenticated = true;
          void startAuthenticatedSession();
          return;
        }

        if (!authenticated) {
          writeMessage(socket, {
            kind: 'error',
            code: 'unauthorized',
            message: 'IPC: authenticate before sending commands',
          });
          socket.destroy();
          detachClient();
          return;
        }

        if (msg.kind === 'user_input') {
          try {
            onUserInput(msg.text);
          } catch (err) {
            bus.publish({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: `IPC: onUserInput threw: ${toErrorMessage(err)}`,
            });
          }
        } else if (msg.kind === 'prompt_response') {
          if (!promptTracker.handleResponse(msg.requestId, msg.response)) {
            bus.publish({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: `IPC: response for unknown prompt ${msg.requestId}`,
            });
          }
        } else if (msg.kind === 'detach') {
          detachClient();
          socket.destroy();
        }
      },
      {
        maxLineBytes: IPC_MAX_FRAME_BYTES,
        onOverflow: (bytes) => {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: `IPC: client frame too large: ${bytes} bytes`,
          });
          socket.destroy();
          detachClient();
        },
      },
    );

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      lineBuffer.push(chunk);
    });

    socket.on('close', () => {
      detachClient();
    });

    socket.on('error', (err) => {
      bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC client error: ${toErrorMessage(err)}`,
      });
      detachClient();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => {
      reject(ipcServerError.bindFailed(err.message));
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
      promptTracker.rejectAll((request) => ipcPromptError.cancelledWhileClosing(request.kind));

      if (currentClient) {
        try {
          if (!currentClient.socket.destroyed) {
            writeMessage(currentClient.socket, { kind: 'server_complete' });
          }
        } catch {
          /* ignore */
        }
        try {
          currentClient.unsubscribe();
        } catch {
          /* ignore */
        }
        try {
          currentClient.socket.destroy();
        } catch {
          /* ignore */
        }
        currentClient = null;
      }

      return new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(sockPath);
          } catch {
            /* ignore ENOENT */
          }
          resolve();
        });
      });
    },
  };
}
