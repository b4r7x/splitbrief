import { useState, useEffect, useRef } from 'react';
import { createConnection, type Socket } from 'node:net';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { IpcPromptRequest, IpcPromptResponse, ServerMessage } from '../../../engine/ipc/protocol.js';
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

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 5000;

function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export function useIpcClient(opts: {
  sockPath: string;
  onEvent: (event: EngineEvent) => void;
  onPromptRequest?: ((request: IpcPromptRequest) => Promise<IpcPromptResponse>) | undefined;
  enabled?: boolean | undefined;
}): [IpcClientState, IpcClientActions] {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<IpcClientState>({
    status: 'connecting',
    sessionId: null,
    readonly: false,
  });

  const socketRef = useRef<Socket | null>(null);
  const attemptRef = useRef(0);
  const bufferRef = useRef('');
  // Use refs for flags that are checked in async callbacks to avoid stale closures
  const isDetachedRef = useRef(false);
  const generationRef = useRef(0);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  const onPromptRequestRef = useRef(opts.onPromptRequest);
  onPromptRequestRef.current = opts.onPromptRequest;

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let disposed = false;
    const sockets = new Set<Socket>();
    const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
    const ownsEffect = () => generationRef.current === generation && !disposed;
    const ownsSocket = (socket: Socket) => ownsEffect() && socketRef.current === socket;
    const canMutate = (socket?: Socket) =>
      ownsEffect() && !isDetachedRef.current && (socket === undefined || socketRef.current === socket);
    const clearReconnectTimers = () => {
      for (const timer of reconnectTimers) clearTimeout(timer);
      reconnectTimers.clear();
    };

    if (!enabled) {
      setState({
        status: 'detached',
        sessionId: null,
        readonly: false,
      });
      return () => {
        disposed = true;
        clearReconnectTimers();
      };
    }

    isDetachedRef.current = false;
    attemptRef.current = 0;
    setState(prev => ({
      ...prev,
      status: prev.status === 'connected' || prev.status === 'readonly' ? prev.status : 'connecting',
    }));

    function connect() {
      if (!canMutate()) return;

      bufferRef.current = '';
      const socket = createConnection(opts.sockPath);
      sockets.add(socket);
      socketRef.current = socket;

      socket.on('data', (chunk: Buffer) => {
        if (!canMutate(socket)) return;
        bufferRef.current += chunk.toString('utf8');
        const lines = bufferRef.current.split('\n');
        bufferRef.current = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: ServerMessage;
          try {
            msg = JSON.parse(trimmed) as ServerMessage;
          } catch {
            onEventRef.current({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: 'IPC: malformed server message',
            });
            continue;
          }
          if (!canMutate(socket)) return;
          if (msg.kind === 'session_meta') {
            setState({
              status: msg.readonly ? 'readonly' : 'connected',
              sessionId: msg.sessionId,
              readonly: msg.readonly,
            });
            attemptRef.current = 0;
          } else if (msg.kind === 'event') {
            onEventRef.current(msg.payload);
          } else if (msg.kind === 'prompt_request') {
            const handler = onPromptRequestRef.current;
            if (!handler) {
              onEventRef.current({
                type: 'warning',
                ts: Date.now(),
                phase: 'idle',
                message: `IPC: no prompt handler for ${msg.request.kind}`,
              });
              continue;
            }
            void handler(msg.request)
              .then((response) => {
                if (!ownsSocket(socket) || socket.destroyed) return;
                socket.write(JSON.stringify({
                  kind: 'prompt_response',
                  requestId: msg.request.requestId,
                  response,
                }) + '\n');
              })
              .catch((err) => {
                if (!canMutate(socket)) return;
                onEventRef.current({
                  type: 'warning',
                  ts: Date.now(),
                  phase: 'idle',
                  message: `IPC: prompt handler failed: ${toErrorMessage(err)}`,
                });
              });
          } else if (msg.kind === 'error') {
            isDetachedRef.current = true;
            setState(prev => ({ ...prev, status: 'failed' }));
            onEventRef.current({
              type: 'warning',
              ts: Date.now(),
              phase: 'idle',
              message: msg.message,
            });
            socket.destroy();
          }
        }
      });

      socket.on('connect', () => {
        if (!canMutate(socket)) return;
        // status will be set properly once session_meta arrives;
        // for now just stay in 'connecting' until meta is received
      });

      socket.on('timeout', () => {
        if (!canMutate(socket)) return;
        socket.destroy();
      });

      socket.on('error', () => {
        // 'close' will follow; handled there
      });

      socket.on('close', () => {
        sockets.delete(socket);
        if (!canMutate(socket)) return;
        if (socketRef.current === socket) socketRef.current = null;

        const attempt = attemptRef.current;
        if (attempt >= MAX_ATTEMPTS) {
          setState(prev => ({ ...prev, status: 'failed' }));
          onEventRef.current({
            type: 'ipc_reconnect_failed',
            ts: Date.now(),
            phase: 'idle',
          });
          return;
        }

        setState(prev => ({ ...prev, status: 'reconnecting' }));
        onEventRef.current({
          type: 'ipc_reconnect_attempt',
          ts: Date.now(),
          phase: 'idle',
          attempt,
          maxAttempts: MAX_ATTEMPTS,
        });

        attemptRef.current = attempt + 1;
        const delay = backoffDelay(attempt);
        const timer = setTimeout(() => {
          reconnectTimers.delete(timer);
          if (!canMutate()) return;
          connect();
        }, delay);
        reconnectTimers.add(timer);
      });
    }

    connect();

    return () => {
      disposed = true;
      clearReconnectTimers();
      for (const socket of sockets) {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        socket.destroy();
      }
      sockets.clear();
    };
  }, [enabled, opts.sockPath]);

  function sendUserInput(text: string) {
    const s = socketRef.current;
    if (!s || state.status !== 'connected') return;
    try {
      s.write(JSON.stringify({ kind: 'user_input', text }) + '\n');
    } catch {
      // socket may have closed; ignore
    }
  }

  function detach() {
    isDetachedRef.current = true;
    generationRef.current += 1;
    setState(prev => ({ ...prev, status: 'detached' }));
    const socket = socketRef.current;
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify({ kind: 'detach' }) + '\n');
      } catch {
        // ignore write errors during detach
      }
      socket.destroy();
    }
    socketRef.current = null;
  }

  return [state, { sendUserInput, detach }];
}
