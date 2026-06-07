import { createConnection, type Socket } from 'node:net';
import type { EngineEvent } from '../../../engine/events/types.js';
import type {
  IpcPromptRequest,
  IpcPromptResponse,
  ServerMessage,
} from '../../../engine/ipc/protocol.js';
import { IPC_MAX_FRAME_BYTES, parseServerMessage } from '../../../engine/ipc/protocol.js';
import { createLineBuffer } from '../../../lib/process/line-buffer.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

export type IpcClientStatus =
  | 'connecting'
  | 'connected'
  | 'readonly'
  | 'reconnecting'
  | 'failed'
  | 'detached';

export type IpcClientState = {
  status: IpcClientStatus;
  sessionId: string | null;
  readonly: boolean;
};

export type IpcClientActions = {
  sendUserInput(text: string): void;
  detach(): void;
};

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 5000;

export function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

type SetIpcClientState = (
  next: IpcClientState | ((prev: IpcClientState) => IpcClientState),
) => void;

type ServerMessageCallbacks = {
  socket: Socket;
  setState: SetIpcClientState;
  onEvent: (event: EngineEvent) => void;
  hasPromptHandler: () => boolean;
  handlePromptRequest: (request: IpcPromptRequest) => Promise<IpcPromptResponse>;
  ownsSocket: (socket: Socket) => boolean;
  canMutate: (socket?: Socket) => boolean;
  markDetached: () => void;
  resetAttempts: () => void;
};

export function handleServerMessage(msg: ServerMessage, callbacks: ServerMessageCallbacks): void {
  const { socket, setState, onEvent } = callbacks;
  if (!callbacks.canMutate(socket)) return;
  if (msg.kind === 'session_meta') {
    setState({
      status: msg.readonly ? 'readonly' : 'connected',
      sessionId: msg.sessionId,
      readonly: msg.readonly,
    });
    callbacks.resetAttempts();
  } else if (msg.kind === 'event') {
    onEvent(msg.payload);
  } else if (msg.kind === 'prompt_request') {
    if (!callbacks.hasPromptHandler()) {
      onEvent({
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: no prompt handler for ${msg.request.kind}`,
      });
      return;
    }
    void callbacks
      .handlePromptRequest(msg.request)
      .then((response: IpcPromptResponse) => {
        if (!callbacks.ownsSocket(socket) || socket.destroyed) return;
        socket.write(
          JSON.stringify({ kind: 'prompt_response', requestId: msg.request.requestId, response }) +
            '\n',
        );
      })
      .catch((err: unknown) => {
        if (!callbacks.canMutate(socket)) return;
        onEvent({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: `IPC: prompt handler failed: ${toErrorMessage(err)}`,
        });
      });
  } else if (msg.kind === 'error') {
    callbacks.markDetached();
    setState((prev) => ({ ...prev, status: 'failed' }));
    onEvent({ type: 'warning', ts: Date.now(), phase: 'idle', message: msg.message });
    socket.destroy();
  } else if (msg.kind === 'server_complete') {
    callbacks.markDetached();
    setState((prev) => ({ ...prev, status: 'detached' }));
  }
}

export function createIpcConnection(opts: {
  sockPath: string;
  authToken: string;
  callbacks: Omit<ServerMessageCallbacks, 'socket'>;
  onClose: (socket: Socket) => void;
}): Socket {
  const socket = createConnection(opts.sockPath);
  const { callbacks } = opts;
  const { onEvent } = callbacks;
  const lineBuffer = createLineBuffer(
    (line) => {
      if (!callbacks.canMutate(socket)) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        onEvent({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: 'IPC: malformed server message',
        });
        return;
      }
      const msg = parseServerMessage(parsed);
      if (msg === null) {
        onEvent({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: 'IPC: invalid server message structure',
        });
        return;
      }
      handleServerMessage(msg, { ...callbacks, socket });
    },
    {
      maxLineBytes: IPC_MAX_FRAME_BYTES,
      onOverflow: (bytes) => {
        onEvent({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: `IPC: server frame too large: ${bytes} bytes`,
        });
        socket.destroy();
      },
    },
  );

  socket.on('data', (chunk: Buffer) => {
    lineBuffer.push(chunk.toString('utf8'));
  });
  socket.on('connect', () => {
    if (!callbacks.canMutate(socket)) return;
    socket.write(JSON.stringify({ kind: 'authenticate', token: opts.authToken }) + '\n');
  });
  socket.on('timeout', () => {
    if (!callbacks.canMutate(socket)) return;
    socket.destroy();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    opts.onClose(socket);
  });
  return socket;
}

export function handleIpcConnectionClose(opts: {
  socket: Socket;
  canMutate: (socket?: Socket) => boolean;
  clearCurrentSocket: (socket: Socket) => void;
  getAttempt: () => number;
  setAttempt: (attempt: number) => void;
  setState: SetIpcClientState;
  onEvent: (event: EngineEvent) => void;
  backoff: (attempt: number) => number;
  reconnect: (delay: number) => void;
}): void {
  const { socket, canMutate, setState, onEvent } = opts;
  if (!canMutate(socket)) return;
  opts.clearCurrentSocket(socket);
  const attempt = opts.getAttempt();
  if (attempt >= MAX_ATTEMPTS) {
    setState((prev) => ({ ...prev, status: 'failed' }));
    onEvent({ type: 'ipc_reconnect_failed', ts: Date.now(), phase: 'idle' });
    return;
  }
  setState((prev) => ({ ...prev, status: 'reconnecting' }));
  onEvent({
    type: 'ipc_reconnect_attempt',
    ts: Date.now(),
    phase: 'idle',
    attempt,
    maxAttempts: MAX_ATTEMPTS,
  });
  opts.setAttempt(attempt + 1);
  opts.reconnect(opts.backoff(attempt));
}

export function scheduleIpcReconnect(
  timers: Set<ReturnType<typeof setTimeout>>,
  delay: number,
  canMutate: () => boolean,
  connect: () => void,
): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!canMutate()) return;
    connect();
  }, delay);
  timers.add(timer);
}

export function destroyIpcSockets(
  sockets: Set<Socket>,
  socketRef: { current: Socket | null },
): void {
  for (const socket of sockets) {
    if (socketRef.current === socket) socketRef.current = null;
    socket.destroy();
  }
  sockets.clear();
}
