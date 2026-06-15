import { useState, useEffect, useEffectEvent, useRef } from 'react';
import type { Socket } from 'node:net';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { IpcPromptRequest, IpcPromptResponse } from '../../../engine/ipc/protocol.js';
import {
  backoffDelay,
  createIpcConnection,
  destroyIpcSockets,
  handleIpcConnectionClose,
  scheduleIpcReconnect,
  type IpcClientActions,
  type IpcClientState,
} from '../../../engine/ipc/client.js';

export type {
  IpcClientActions,
  IpcClientState,
  IpcClientStatus,
} from '../../../engine/ipc/client.js';

export function useIpcClient(opts: {
  sockPath: string;
  authToken: string;
  onEvent: (event: EngineEvent) => void;
  onPromptRequest?: ((request: IpcPromptRequest) => Promise<IpcPromptResponse>) | undefined;
  enabled?: boolean | undefined;
  backoffMs?: ((attempt: number) => number) | undefined;
}): [IpcClientState, IpcClientActions] {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<IpcClientState>({
    status: 'connecting',
    sessionId: null,
  });

  const socketRef = useRef<Socket | null>(null);
  const attemptRef = useRef(0);
  const isDetachedRef = useRef(false);
  const generationRef = useRef(0);

  const onEvent = useEffectEvent(opts.onEvent);
  const hasPromptHandler = useEffectEvent(() => opts.onPromptRequest !== undefined);
  const handlePromptRequest = useEffectEvent(
    (request: IpcPromptRequest): Promise<IpcPromptResponse> => {
      const handler = opts.onPromptRequest;
      if (!handler) {
        return Promise.reject(new Error('IPC: no prompt handler registered'));
      }
      return handler(request);
    },
  );
  const backoff = useEffectEvent((attempt: number) => (opts.backoffMs ?? backoffDelay)(attempt));

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let disposed = false;
    const sockets = new Set<Socket>();
    const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
    const ownsEffect = () => generationRef.current === generation && !disposed;
    const ownsSocket = (socket: Socket) => ownsEffect() && socketRef.current === socket;
    const canMutate = (socket?: Socket) =>
      ownsEffect() &&
      !isDetachedRef.current &&
      (socket === undefined || socketRef.current === socket);
    const clearReconnectTimers = () => {
      for (const timer of reconnectTimers) clearTimeout(timer);
      reconnectTimers.clear();
    };

    if (!enabled) {
      setState({
        status: 'detached',
        sessionId: null,
      });
      return () => {
        disposed = true;
        clearReconnectTimers();
      };
    }

    isDetachedRef.current = false;
    attemptRef.current = 0;
    setState((prev) => ({
      ...prev,
      status: prev.status === 'connected' ? prev.status : 'connecting',
    }));

    function connect() {
      if (!canMutate()) return;

      const socket = createIpcConnection({
        sockPath: opts.sockPath,
        authToken: opts.authToken,
        callbacks: {
          setState,
          onEvent,
          hasPromptHandler,
          handlePromptRequest,
          ownsSocket,
          canMutate,
          markDetached: () => {
            isDetachedRef.current = true;
          },
          resetAttempts: () => {
            attemptRef.current = 0;
          },
        },
        onClose: (closedSocket) => {
          sockets.delete(closedSocket);
          handleIpcConnectionClose({
            socket: closedSocket,
            canMutate,
            clearCurrentSocket: (socketToClear) => {
              if (socketRef.current === socketToClear) socketRef.current = null;
            },
            getAttempt: () => attemptRef.current,
            setAttempt: (attempt) => {
              attemptRef.current = attempt;
            },
            setState,
            onEvent,
            backoff,
            reconnect: (delay) => scheduleIpcReconnect(reconnectTimers, delay, canMutate, connect),
          });
        },
      });
      sockets.add(socket);
      socketRef.current = socket;
    }

    connect();

    return () => {
      disposed = true;
      clearReconnectTimers();
      destroyIpcSockets(sockets, socketRef);
    };
  }, [enabled, opts.sockPath, opts.authToken]);

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
    setState((prev) => ({ ...prev, status: 'detached' }));
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
