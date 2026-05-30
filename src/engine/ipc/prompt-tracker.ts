import type { Socket } from 'node:net';
import { error, type AppError } from '../../utils/error.js';
import type { EventBus } from '../events/types.js';
import type {
  IpcPromptRequest,
  IpcPromptRequestInput,
  IpcPromptResponse,
  ServerMessage,
} from './protocol.js';

export type IpcPromptUnavailableError = AppError<
  'ipc-prompt-no-client-headless',
  {
    promptKind: IpcPromptRequest['kind'];
  }
> & {
  code: 'ipc_prompt_no_client_headless';
  promptKind: IpcPromptRequest['kind'];
};

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

function createNoClientPromptError(request: IpcPromptRequest): IpcPromptUnavailableError {
  return Object.assign(
    error(
      'ipc-prompt-no-client-headless',
      `IPC prompt cannot be answered in explicit headless mode without an attached client: ${request.kind}`,
      { promptKind: request.kind },
    ),
    {
      code: 'ipc_prompt_no_client_headless' as const,
      promptKind: request.kind,
    },
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

        const timer = setTimeout(() => {
          pendingPrompts.delete(request.requestId);
          reject(new Error(`IPC prompt timed out after 30s: ${request.kind}`));
        }, 30_000);

        pendingPrompts.set(request.requestId, {
          request,
          resolve: (response) => {
            clearTimeout(timer);
            resolve(response);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
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
