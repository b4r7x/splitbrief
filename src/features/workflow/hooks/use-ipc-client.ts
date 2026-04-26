import { useState, useEffect, useRef } from 'react';
import { createConnection, type Socket } from 'node:net';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { ServerMessage } from '../../../engine/ipc/protocol.js';

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
  const isUnmountedRef = useRef(false);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  const sockPathRef = useRef(opts.sockPath);
  sockPathRef.current = opts.sockPath;

  useEffect(() => {
    if (!enabled) {
      setState({
        status: 'detached',
        sessionId: null,
        readonly: false,
      });
      return undefined;
    }

    isUnmountedRef.current = false;
    isDetachedRef.current = false;
    attemptRef.current = 0;
    setState(prev => ({
      ...prev,
      status: prev.status === 'connected' || prev.status === 'readonly' ? prev.status : 'connecting',
    }));

    function connect() {
      if (isUnmountedRef.current || isDetachedRef.current) return;

      bufferRef.current = '';
      const socket = createConnection(sockPathRef.current);
      socketRef.current = socket;

      socket.on('data', (chunk: Buffer) => {
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
          if (isUnmountedRef.current) return;
          if (msg.kind === 'session_meta') {
            setState({
              status: msg.readonly ? 'readonly' : 'connected',
              sessionId: msg.sessionId,
              readonly: msg.readonly,
            });
            attemptRef.current = 0;
          } else if (msg.kind === 'event') {
            onEventRef.current(msg.payload);
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
        if (isUnmountedRef.current || isDetachedRef.current) return;
        // status will be set properly once session_meta arrives;
        // for now just stay in 'connecting' until meta is received
      });

      socket.on('timeout', () => {
        if (isUnmountedRef.current || isDetachedRef.current) return;
        socket.destroy();
      });

      socket.on('error', () => {
        // 'close' will follow; handled there
      });

      socket.on('close', () => {
        if (isUnmountedRef.current || isDetachedRef.current) return;

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
        setTimeout(() => {
          if (isUnmountedRef.current || isDetachedRef.current) return;
          connect();
        }, delay);
      });
    }

    connect();

    return () => {
      isUnmountedRef.current = true;
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.destroy();
      }
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
