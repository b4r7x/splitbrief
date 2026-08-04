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
  type ClientMessage,
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
import { protectEngineEventForConsumer } from '../events/protection/protect.js';

export type IpcServerOptions = {
  sessionId: string;
  sessionDir: string;
  startedAt: number;
  mode: WorkflowMode;
  feature: string;
  authToken: string;
  bus: EventBus;
  onUserInput: (text: string) => void;
  onQueueClear?: (() => void) | undefined;
  sessionJsonlPath?: string;
  noClientPromptBehavior?: 'wait' | 'fail-closed';
  persistTranscript?: boolean | undefined;
  onParentAccept?:
    | ((
        acceptance: Omit<Extract<ClientMessage, { kind: 'parent_accept' }>, 'kind' | 'token'>,
      ) => boolean)
    | undefined;
};

export type IpcServer = {
  readonly sockPath: string;
  requestClientPrompt(request: IpcPromptRequestInput): Promise<IpcPromptResponse>;
  close(): Promise<void>;
};

const MAX_LIVE_BACKLOG_EVENTS = 1000;

function eventIdentity(event: EngineEvent, persistTranscript: boolean): string | null {
  const protectedEvent = protectEngineEventForConsumer(event, {
    context: 'ipc',
    persistTranscript,
  });
  return protectedEvent === null ? null : canonicalJSON(protectedEvent);
}

export const ipcServerError = {
  bindFailed: (reason: string) =>
    error('ipc-server-bind-failed', `IPC server failed to bind: ${reason}`, { reason }),
} as const;

function publishIpcOperationalWarning(bus: EventBus, message: string, code: string): void {
  bus.publish({
    type: 'warning',
    ts: Date.now(),
    phase: 'idle',
    category: 'ipc',
    code,
    transcriptSafe: true,
    message,
  });
}

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
    onQueueClear,
    sessionJsonlPath,
    noClientPromptBehavior = 'wait',
    persistTranscript = true,
    onParentAccept,
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
              category: 'ipc',
              code: 'live_backlog_exceeded',
              transcriptSafe: true,
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
          for (const event of replayed) {
            const identity = eventIdentity(event, persistTranscript);
            if (identity !== null) replayedIdentities.add(identity);
          }
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
        const identity = eventIdentity(event, persistTranscript);
        if (identity !== null && replayedIdentities.delete(identity)) continue;
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
            const byteLength = Buffer.byteLength(trimmed, 'utf8');
            publishIpcOperationalWarning(
              bus,
              `IPC: invalid message structure from client (${byteLength} bytes)`,
              'invalid_message_structure',
            );
            return;
          }
        } catch {
          const byteLength = Buffer.byteLength(trimmed, 'utf8');
          publishIpcOperationalWarning(
            bus,
            `IPC: malformed JSON from client (${byteLength} bytes)`,
            'malformed_json',
          );
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

        if (msg.kind === 'parent_accept') {
          const accepted =
            tokensMatch(msg.token, authToken) &&
            onParentAccept?.({
              version: msg.version,
              sessionId: msg.sessionId,
              generation: msg.generation,
              childPid: msg.childPid,
            }) === true;
          if (!accepted) {
            writeMessage(socket, {
              kind: 'error',
              code: 'unauthorized',
              message: 'IPC: invalid detached parent acceptance',
            });
            socket.end();
            return;
          }
          writeMessage(socket, {
            kind: 'parent_accepted',
            version: msg.version,
            sessionId: msg.sessionId,
            generation: msg.generation,
            childPid: msg.childPid,
          });
          socket.end();
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
        } else if (msg.kind === 'queue_clear') {
          if (!onQueueClear) {
            publishIpcOperationalWarning(
              bus,
              'IPC: queue clear is not available for this workflow',
              'queue_clear_unavailable',
            );
            return;
          }
          try {
            onQueueClear();
          } catch (err) {
            bus.publish({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: `IPC: onQueueClear threw: ${toErrorMessage(err)}`,
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
        onOverflow: (overflow) => {
          publishIpcOperationalWarning(
            bus,
            `IPC: client frame too large: ${overflow.lineBytes} bytes`,
            'client_frame_too_large',
          );
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
