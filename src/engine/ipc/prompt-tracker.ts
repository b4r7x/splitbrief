import type { Socket } from 'node:net';
import { error } from '../../utils/error.js';
import type { EventBus } from '../events/types.js';
import type {
  IpcPromptRequest,
  IpcPromptRequestInput,
  IpcPromptResponse,
  ServerMessage,
} from './protocol.js';

type PendingPrompt = {
  request: IpcPromptRequest;
  resolve: (response: IpcPromptResponse) => void;
  reject: (err: Error) => void;
};

type PromptTrackerOptions = {
  bus: EventBus;
  noClientPromptBehavior: 'wait' | 'fail-closed';
  currentSocket: () => Socket | null;
  writeMessage: (socket: Socket, msg: ServerMessage) => void;
};

export const ipcPromptError = {
  cancelledWhileClosing: (promptKind: IpcPromptRequest['kind']) =>
    error(
      'ipc-prompt-cancelled-closing',
      `IPC prompt cancelled while closing server: ${promptKind}`,
      { promptKind },
    ),
} as const;

function createNoClientPromptError(request: IpcPromptRequest) {
  return error(
    'ipc-prompt-no-client-headless',
    `IPC prompt cannot be answered in explicit headless mode without an attached client: ${request.kind}`,
    { promptKind: request.kind },
  );
}

export function createPromptTracker(opts: PromptTrackerOptions) {
  let nextPromptId = 1;
  const pendingPrompts = new Map<string, PendingPrompt>();

  function sendPrompt(socket: Socket, request: IpcPromptRequest): void {
    opts.writeMessage(socket, { kind: 'prompt_request', request });
  }

  return {
    handleResponse(requestId: string, response: IpcPromptResponse): boolean {
      const pending = pendingPrompts.get(requestId);
      if (!pending) return false;

      if (response.kind !== pending.request.kind) {
        opts.bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: `IPC: response kind mismatch for ${requestId}: expected ${pending.request.kind}, got ${response.kind}`,
        });
        return false;
      }
      if (!responseAllowedForRequest(response, pending.request)) {
        opts.bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: `IPC: response rejected for ${requestId}: recovery action is not available`,
        });
        return false;
      }

      pendingPrompts.delete(requestId);
      pending.resolve(response);
      return true;
    },
    sendPendingPrompts(socket: Socket): void {
      for (const pending of pendingPrompts.values()) {
        sendPrompt(socket, pending.request);
      }
    },
    requestClientPrompt(requestWithoutId: IpcPromptRequestInput): Promise<IpcPromptResponse> {
      const request = {
        ...requestWithoutId,
        requestId: `prompt-${nextPromptId++}`,
      } as IpcPromptRequest;

      return new Promise<IpcPromptResponse>((resolve, reject) => {
        const currentSocket = opts.currentSocket();
        if (!currentSocket && opts.noClientPromptBehavior === 'fail-closed') {
          const err = createNoClientPromptError(request);
          opts.bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: err.message,
          });
          reject(err);
          return;
        }

        pendingPrompts.set(request.requestId, { request, resolve, reject });
        if (currentSocket) {
          sendPrompt(currentSocket, request);
        } else {
          opts.bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: `IPC prompt waiting for attached client: ${request.kind}`,
          });
        }
      });
    },
    rejectAll(errFor: (request: IpcPromptRequest) => Error): void {
      for (const pending of pendingPrompts.values()) {
        pending.reject(errFor(pending.request));
      }
      pendingPrompts.clear();
    },
  };
}

function responseAllowedForRequest(
  response: IpcPromptResponse,
  request: IpcPromptRequest,
): boolean {
  if (response.kind !== 'recovery_needed' || request.kind !== 'recovery_needed') return true;
  return request.issue.availableActions.includes(response.action);
}
