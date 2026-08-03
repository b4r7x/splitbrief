import type { Socket } from 'node:net';
import { error } from '../../utils/error.js';
import type { EventBus } from '../events/types.js';
import type {
  IpcPromptRequest,
  IpcPromptRequestInput,
  IpcPromptResponse,
  ServerMessage,
} from './protocol.js';
import { artifactReviewPromptFrameBytes, IPC_MAX_FRAME_BYTES } from './protocol.js';
import type { TaskReviewCommand, TaskReviewResponse } from '../events/workflow-events.js';
import {
  allowedSettlingBriefReviewCommandsForPrompt,
  briefReviewCommandToApprovalReviewResult,
} from '../../core/schemas/brief-review-command.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../runners/types.js';

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

type PromptErrorData =
  | { promptKind: IpcPromptRequest['kind'] }
  | {
      promptKind: 'approval_needed';
      approvalType: Extract<IpcPromptRequest, { kind: 'approval_needed' }>['approvalType'];
      artifactPath: string;
    };

const MAX_PROMPT_DIAGNOSTIC_BYTES = 2048;

export const ipcPromptError = {
  cancelledWhileClosing: (promptKind: IpcPromptRequest['kind']) =>
    error(
      'ipc-prompt-cancelled-closing',
      `IPC prompt cancelled while closing server: ${promptKind}`,
      { promptKind },
    ),
  artifactReviewTooLarge: (textBytes: number, frameBytes: number) =>
    error(
      'ipc-artifact-review-too-large',
      'IPC artifact review exceeds the supported delivery limit.',
      {
        promptKind: 'artifact_review',
        textBytes,
        frameBytes,
      },
    ),
} as const;

function createNoClientPromptError(request: IpcPromptRequest) {
  const descriptor = describePromptForDiagnostic(request);
  return error(
    'ipc-prompt-no-client-headless',
    `IPC prompt cannot be answered in explicit headless mode without an attached client: ${descriptor}`,
    promptErrorData(request),
  );
}

function promptErrorData(request: IpcPromptRequest): PromptErrorData {
  if (request.kind !== 'approval_needed') return { promptKind: request.kind };
  return {
    promptKind: request.kind,
    approvalType: request.approvalType,
    artifactPath: boundedDiagnosticText(request.filePath),
  };
}

function describePromptForDiagnostic(request: IpcPromptRequest): string {
  if (request.kind !== 'approval_needed') return request.kind;
  return `${request.kind} ${request.approvalType} artifact=${boundedDiagnosticText(request.filePath)}`;
}

function boundedDiagnosticText(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_DIAGNOSTIC_BYTES) return value;
  let text = value;
  while (Buffer.byteLength(`${text}...`, 'utf8') > MAX_PROMPT_DIAGNOSTIC_BYTES && text.length > 0) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
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
      const allowed = responseAllowedForRequest(response, pending.request);
      if (!allowed.ok) {
        opts.bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: 'idle',
          message: `IPC: response rejected for ${requestId}: ${allowed.message}`,
        });
        return false;
      }

      const settled = settlePromptResponse(response);
      pendingPrompts.delete(requestId);
      pending.resolve(settled);
      return true;
    },
    sendPendingPrompts(socket: Socket): void {
      for (const pending of pendingPrompts.values()) {
        sendPrompt(socket, pending.request);
      }
    },
    requestClientPrompt(requestWithoutId: IpcPromptRequestInput): Promise<IpcPromptResponse> {
      const request = createPromptRequest(requestWithoutId, `prompt-${nextPromptId++}`);
      const artifactReviewError = artifactReviewTransportError(request);
      if (artifactReviewError !== null) return Promise.reject(artifactReviewError);

      return new Promise<IpcPromptResponse>((resolve, reject) => {
        const currentSocket = opts.currentSocket();
        if (!currentSocket && opts.noClientPromptBehavior === 'fail-closed') {
          const err = createNoClientPromptError(request);
          opts.bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: 'idle',
            message: err.message,
            category: 'ipc',
            code: 'prompt_unavailable_headless',
            transcriptSafe: true,
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
            category: 'ipc',
            code: 'prompt_waiting_for_client',
            transcriptSafe: true,
            message: `IPC prompt waiting for attached client: ${describePromptForDiagnostic(request)}`,
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

function createPromptRequest(
  requestWithoutId: IpcPromptRequestInput,
  requestId: string,
): IpcPromptRequest {
  switch (requestWithoutId.kind) {
    case 'approval_needed':
      return {
        requestId,
        kind: requestWithoutId.kind,
        approvalType: requestWithoutId.approvalType,
        filePath: requestWithoutId.filePath,
        allowedCommands: [
          ...allowedSettlingBriefReviewCommandsForPrompt(requestWithoutId.approvalType),
        ],
      };
    case 'artifact_review':
      return {
        requestId,
        kind: requestWithoutId.kind,
        review: requestWithoutId.review,
      };
    case 'user_edit_conflict':
      return { requestId, kind: requestWithoutId.kind, conflict: requestWithoutId.conflict };
    case 'question_asked':
      return {
        requestId,
        kind: requestWithoutId.kind,
        question: requestWithoutId.question,
        num: requestWithoutId.num,
        total: requestWithoutId.total,
      };
    case 'continuation_needed':
      return {
        requestId,
        kind: requestWithoutId.kind,
        partialResponse: requestWithoutId.partialResponse,
      };
    case 'tiered_approval':
      return { requestId, kind: requestWithoutId.kind, request: requestWithoutId.request };
    case 'cost_approval':
      return { requestId, kind: requestWithoutId.kind, prediction: requestWithoutId.prediction };
    case 'task_review':
      return { requestId, kind: requestWithoutId.kind, request: requestWithoutId.request };
    case 'recovery_needed':
      return { requestId, kind: requestWithoutId.kind, issue: requestWithoutId.issue };
    default: {
      const exhaustive: never = requestWithoutId;
      return exhaustive;
    }
  }
}

function artifactReviewTransportError(request: IpcPromptRequest): Error | null {
  if (request.kind !== 'artifact_review') return null;

  const textBytes = Buffer.byteLength(request.review.text, 'utf8');
  const frameBytes = artifactReviewPromptFrameBytes(request);
  if (textBytes <= PLANNER_ARTIFACT_MAX_BYTES && frameBytes <= IPC_MAX_FRAME_BYTES) return null;
  return ipcPromptError.artifactReviewTooLarge(textBytes, frameBytes);
}

function settlePromptResponse(response: IpcPromptResponse): IpcPromptResponse {
  if (response.kind !== 'approval_needed' || !('command' in response)) return response;
  const result = briefReviewCommandToApprovalReviewResult(response.command);
  if (result === null) return response;
  return { kind: response.kind, ...result };
}

function responseAllowedForRequest(
  response: IpcPromptResponse,
  request: IpcPromptRequest,
): { ok: true } | { ok: false; message: string } {
  if (response.kind === 'recovery_needed' && request.kind === 'recovery_needed') {
    return request.issue.availableActions.includes(response.action)
      ? { ok: true }
      : { ok: false, message: 'recovery action is not available' };
  }
  if (response.kind === 'approval_needed' && request.kind === 'approval_needed') {
    if (!('command' in response)) return { ok: true };
    if (request.approvalType !== 'briefs') {
      return { ok: false, message: 'Task Brief review command is not available for this prompt' };
    }
    if (!request.allowedCommands.includes(response.command.action)) {
      return { ok: false, message: 'Task Brief review command is not allowed for this prompt' };
    }
    if (briefReviewCommandToApprovalReviewResult(response.command) === null) {
      return {
        ok: false,
        message: `Task Brief review command does not resolve the prompt: ${response.command.action}`,
      };
    }
  }
  if (response.kind === 'task_review' && request.kind === 'task_review') {
    return taskReviewResponseAllowed(response.response, request.request.availableCommands)
      ? { ok: true }
      : { ok: false, message: 'task review action is not available' };
  }
  return { ok: true };
}

function taskReviewResponseAllowed(
  response: TaskReviewResponse,
  availableCommands: readonly TaskReviewCommand[],
): boolean {
  if (response.notes !== undefined && response.action === 'continue') {
    return availableCommands.includes('edit-notes');
  }
  return availableCommands.includes(response.action);
}
