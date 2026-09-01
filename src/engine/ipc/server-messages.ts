import type { Socket } from 'node:net';
import type { EventBus } from '../events/types.js';
import type { ClientMessage, IpcPromptResponse, ServerMessage } from './protocol.js';
import { tokensMatch } from './control-detach.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { publishIpcOperationalWarning } from './operational-warning.js';

export type ClientMessageDeps = {
  socket: Socket;
  bus: EventBus;
  writeMessage: (socket: Socket, msg: ServerMessage) => void;
  authToken: string;
  onUserInput: (text: string) => void;
  onQueueClear?: (() => void) | undefined;
  onParentAccept?:
    | ((
        acceptance: Omit<Extract<ClientMessage, { kind: 'parent_accept' }>, 'kind' | 'token'>,
      ) => boolean)
    | undefined;
  promptTracker: {
    handleResponse(requestId: string, response: IpcPromptResponse): boolean;
  };
  isAuthenticated: () => boolean;
  markAuthenticated: () => void;
  detachClient: () => void;
  startAuthenticatedSession: () => Promise<void>;
  releasePendingUnauthenticated: () => void;
};

export function handleClientMessage(msg: ClientMessage, deps: ClientMessageDeps): void {
  const { socket, bus, writeMessage } = deps;

  if (msg.kind === 'authenticate') {
    if (!tokensMatch(msg.token, deps.authToken)) {
      writeMessage(socket, {
        kind: 'error',
        code: 'unauthorized',
        message: 'IPC: invalid auth token',
      });
      socket.destroy();
      deps.detachClient();
      return;
    }
    deps.markAuthenticated();
    deps.releasePendingUnauthenticated();
    void deps.startAuthenticatedSession();
    return;
  }

  if (msg.kind === 'parent_accept') {
    const accepted =
      tokensMatch(msg.token, deps.authToken) &&
      deps.onParentAccept?.({
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
      deps.releasePendingUnauthenticated();
      socket.end();
      return;
    }
    deps.releasePendingUnauthenticated();
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

  if (!deps.isAuthenticated()) {
    writeMessage(socket, {
      kind: 'error',
      code: 'unauthorized',
      message: 'IPC: authenticate before sending commands',
    });
    socket.destroy();
    deps.detachClient();
    return;
  }

  if (msg.kind === 'user_input') {
    try {
      deps.onUserInput(msg.text);
    } catch (err) {
      bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: onUserInput threw: ${toErrorMessage(err)}`,
      });
    }
  } else if (msg.kind === 'queue_clear') {
    if (!deps.onQueueClear) {
      publishIpcOperationalWarning(
        bus,
        'IPC: queue clear is not available for this workflow',
        'queue_clear_unavailable',
      );
      return;
    }
    try {
      deps.onQueueClear();
    } catch (err) {
      bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: onQueueClear threw: ${toErrorMessage(err)}`,
      });
    }
  } else if (msg.kind === 'prompt_response') {
    if (!deps.promptTracker.handleResponse(msg.requestId, msg.response)) {
      bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: response for unknown prompt ${msg.requestId}`,
      });
    }
  } else if (msg.kind === 'detach') {
    deps.detachClient();
    socket.destroy();
  }
}
