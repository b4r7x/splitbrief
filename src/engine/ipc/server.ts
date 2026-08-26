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
const MAX_REPLAY_IDENTITY_COUNT = 1024;
const MAX_REPLAY_IDENTITY_BYTES = 4 * 1024 * 1024;

export const IPC_AUTH_DEADLINE_MS = 1_000;
export const IPC_MAX_PENDING_UNAUTHENTICATED_SOCKETS = 32;
export const IPC_MAX_PENDING_UNAUTHENTICATED_BYTES = 4 * IPC_MAX_FRAME_BYTES;

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

type SocketLineBufferOptions = {
  maxLineBytes: number;
  onLine: (line: string) => void;
  onOverflow: (lineBytes: number) => void;
};

function createSocketLineBuffer(opts: SocketLineBufferOptions): {
  push(chunk: Buffer): void;
  bufferedBytes(): number;
} {
  const lineParts: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let overflowReported = false;

  function append(segment: Buffer): void {
    if (oversized || segment.length === 0) return;
    const remaining = opts.maxLineBytes - lineBytes;
    if (segment.length > remaining) {
      if (remaining > 0) lineParts.push(segment.subarray(0, remaining));
      lineBytes = opts.maxLineBytes;
      oversized = true;
      if (!overflowReported) {
        overflowReported = true;
        opts.onOverflow(opts.maxLineBytes + 1);
      }
      return;
    }
    lineParts.push(segment);
    lineBytes += segment.length;
  }

  function finish(): void {
    if (oversized) {
      if (!overflowReported) opts.onOverflow(opts.maxLineBytes + 1);
    } else {
      const line = Buffer.concat(lineParts, lineBytes).toString('utf8');
      opts.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    lineParts.length = 0;
    lineBytes = 0;
    oversized = false;
    overflowReported = false;
  }

  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, offset);
        const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
        append(chunk.subarray(offset, segmentEnd));
        if (newlineIndex === -1) return;
        finish();
        offset = newlineIndex + 1;
      }
    },
    bufferedBytes() {
      return lineBytes;
    },
  };
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
      // A stale socket another process already removed is the same as success here.
    }
  }

  let currentClient: { socket: Socket; unsubscribe: () => void } | null = null;
  const pendingUnauthenticatedSockets = new Set<Socket>();
  let pendingUnauthenticatedBytes = 0;

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

    if (pendingUnauthenticatedSockets.size >= IPC_MAX_PENDING_UNAUTHENTICATED_SOCKETS) {
      writeMessage(socket, {
        kind: 'error',
        code: 'unauthorized',
        message: 'IPC: too many unauthenticated clients',
      });
      socket.destroy();
      return;
    }

    pendingUnauthenticatedSockets.add(socket);

    let detached = false;
    let authenticated = false;
    let replaying = true;
    const replayedIdentities = new Map<string, number>();
    let replayedIdentityBytes = 0;
    let replayStarted = false;
    const liveBacklog: EngineEvent[] = [];
    let pendingBufferedBytes = 0;
    let pendingReleased = false;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const client: { socket: Socket; unsubscribe: () => void } = {
      socket,
      unsubscribe: () => undefined,
    };

    function releasePendingUnauthenticated(): void {
      if (pendingReleased) return;
      pendingReleased = true;
      pendingUnauthenticatedSockets.delete(socket);
      pendingUnauthenticatedBytes = Math.max(0, pendingUnauthenticatedBytes - pendingBufferedBytes);
      pendingBufferedBytes = 0;
      if (authTimer !== undefined) clearTimeout(authTimer);
    }

    function syncPendingBufferedBytes(lineBuffer: { bufferedBytes(): number }): void {
      if (pendingReleased) return;
      const nextBytes = lineBuffer.bufferedBytes();
      pendingUnauthenticatedBytes += nextBytes - pendingBufferedBytes;
      pendingBufferedBytes = nextBytes;
      if (pendingUnauthenticatedBytes <= IPC_MAX_PENDING_UNAUTHENTICATED_BYTES) return;
      publishIpcOperationalWarning(
        bus,
        'IPC: unauthenticated client buffer budget exceeded',
        'unauthenticated_buffer_budget_exceeded',
      );
      writeMessage(socket, {
        kind: 'error',
        code: 'unauthorized',
        message: 'IPC: unauthenticated client buffer budget exceeded',
      });
      socket.destroy();
      detachClient();
    }

    function rememberReplayIdentity(identity: string): void {
      const bytes = Buffer.byteLength(identity, 'utf8');
      if (bytes > MAX_REPLAY_IDENTITY_BYTES) return;
      const previous = replayedIdentities.get(identity);
      if (previous !== undefined) {
        replayedIdentityBytes -= previous;
        replayedIdentities.delete(identity);
      }
      replayedIdentities.set(identity, bytes);
      replayedIdentityBytes += bytes;
      while (
        replayedIdentities.size > MAX_REPLAY_IDENTITY_COUNT ||
        replayedIdentityBytes > MAX_REPLAY_IDENTITY_BYTES
      ) {
        const oldest = replayedIdentities.keys().next();
        if (oldest.done) break;
        const oldestBytes = replayedIdentities.get(oldest.value);
        if (oldestBytes !== undefined) replayedIdentityBytes -= oldestBytes;
        replayedIdentities.delete(oldest.value);
      }
    }

    function consumeReplayIdentity(identity: string): boolean {
      const bytes = replayedIdentities.get(identity);
      if (bytes === undefined) return false;
      replayedIdentityBytes -= bytes;
      replayedIdentities.delete(identity);
      return true;
    }

    function writeEvent(event: EngineEvent): void {
      writeMessage(socket, { kind: 'event', payload: event });
    }

    function detachClient() {
      if (detached) return;
      detached = true;
      releasePendingUnauthenticated();
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
          await replaySession({
            socket,
            sessionJsonlPath,
            writeMessage,
            onEvent: (event) => {
              const identity = eventIdentity(event, persistTranscript);
              if (identity !== null) rememberReplayIdentity(identity);
            },
          });
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
        if (identity !== null && consumeReplayIdentity(identity)) continue;
        writeEvent(event);
      }
      replayedIdentities.clear();
      replayedIdentityBytes = 0;
    }

    const lineBuffer = createSocketLineBuffer({
      maxLineBytes: IPC_MAX_FRAME_BYTES,
      onLine: (line) => {
        if (socket.destroyed) return;
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
          releasePendingUnauthenticated();
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
            releasePendingUnauthenticated();
            socket.end();
            return;
          }
          releasePendingUnauthenticated();
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
      onOverflow: (lineBytes) => {
        publishIpcOperationalWarning(
          bus,
          `IPC: client frame too large: ${lineBytes} bytes`,
          'client_frame_too_large',
        );
        socket.destroy();
        detachClient();
      },
    });

    authTimer = setTimeout(() => {
      if (authenticated || detached || socket.destroyed) return;
      publishIpcOperationalWarning(
        bus,
        'IPC: client authentication timed out',
        'authentication_timeout',
      );
      writeMessage(socket, {
        kind: 'error',
        code: 'unauthorized',
        message: 'IPC: client authentication timed out',
      });
      socket.destroy();
      detachClient();
    }, IPC_AUTH_DEADLINE_MS);
    authTimer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return;
      lineBuffer.push(chunk);
      syncPendingBufferedBytes(lineBuffer);
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

      for (const socket of pendingUnauthenticatedSockets) {
        socket.destroy();
      }

      if (currentClient) {
        try {
          if (!currentClient.socket.destroyed) {
            writeMessage(currentClient.socket, { kind: 'server_complete' });
          }
        } catch {
          // The client is going away; a failed farewell must not block close().
        }
        try {
          currentClient.unsubscribe();
        } catch {
          // Same: an unsubscribe that throws must not strand the remaining teardown.
        }
        try {
          currentClient.socket.destroy();
        } catch {
          // Same: the socket is being abandoned either way.
        }
        currentClient = null;
      }

      return new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(sockPath);
          } catch {
            // The socket file is already gone, which is the state this unlink wants.
          }
          resolve();
        });
      });
    },
  };
}
