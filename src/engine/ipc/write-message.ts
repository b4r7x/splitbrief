import type { Socket } from 'node:net';
import type { IpcPromptRequest, ServerMessage } from './protocol.js';
import { IPC_MAX_FRAME_BYTES, parseServerMessage } from './protocol.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { protectConsumerPayload } from '../../core/consumer-policy.js';
import {
  protectEngineEventForConsumer,
  projectUserEditConflictForTranscriptPolicy,
  TRANSCRIPT_OMITTED_MESSAGE,
} from '../events/protection.js';

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export interface WriteServerMessageOptions {
  persistTranscript?: boolean | undefined;
}

interface ResolvedWriteServerMessageOptions {
  persistTranscript: boolean;
}

export function writeServerMessage(
  socket: Socket,
  msg: ServerMessage,
  opts: WriteServerMessageOptions = {},
): boolean {
  if (socket.destroyed) return false;
  const persistTranscript = opts.persistTranscript ?? true;
  try {
    const protectedMsg = protectServerMessage(msg, { persistTranscript });
    if (protectedMsg === null) return true;
    const protectedBuf = JSON.stringify(protectedMsg) + '\n';
    if (Buffer.byteLength(protectedBuf, 'utf8') > IPC_MAX_FRAME_BYTES) {
      writeOversizeWarning(socket, protectedMsg);
      return true;
    }
    const ok = socket.write(protectedBuf);
    if (!ok && socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
      socket.destroy();
      return false;
    }
    return ok;
  } catch {
    // socket may have closed mid-write; ignore
    return false;
  }
}

function protectServerMessage(
  msg: ServerMessage,
  opts: ResolvedWriteServerMessageOptions,
): ServerMessage | null {
  if (msg.kind === 'event') {
    const event = protectEngineEventForConsumer(msg.payload, {
      context: 'ipc',
      persistTranscript: opts.persistTranscript,
    });
    return event === null ? null : { kind: 'event', payload: event };
  }
  if (msg.kind === 'session_meta' && !opts.persistTranscript) {
    return { ...msg, feature: TRANSCRIPT_OMITTED_MESSAGE };
  }

  const transcriptSafeMsg = projectServerMessageForTranscriptPolicy(msg, opts.persistTranscript);
  const protectedPayload = protectConsumerPayload({ context: 'ipc', payload: transcriptSafeMsg });
  if (protectedPayload.oversized) {
    return {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: dropped oversized ${msg.kind} frame exceeding ${protectedPayload.maxBytes} bytes`,
      },
    };
  }

  const parsed = parseServerMessage(protectedPayload.payload);
  if (parsed !== null) return parsed;

  return {
    kind: 'event',
    payload: {
      type: 'warning',
      ts: Date.now(),
      phase: 'idle',
      message: `IPC: dropped invalid ${msg.kind} frame after public payload normalization`,
    },
  };
}

function projectServerMessageForTranscriptPolicy(
  msg: ServerMessage,
  persistTranscript: boolean,
): ServerMessage {
  if (persistTranscript || msg.kind !== 'prompt_request') return msg;
  return { ...msg, request: projectPromptRequestForTranscriptPolicy(msg.request) };
}

function projectPromptRequestForTranscriptPolicy(request: IpcPromptRequest): IpcPromptRequest {
  switch (request.kind) {
    case 'approval_needed':
      return request;
    case 'user_edit_conflict':
      return {
        ...request,
        conflict: projectUserEditConflictForTranscriptPolicy(request.conflict, false),
      };
    case 'question_asked':
      return { ...request, question: projectClarificationQuestion(request.question) };
    case 'continuation_needed':
      return { ...request, partialResponse: TRANSCRIPT_OMITTED_MESSAGE };
    case 'tiered_approval':
      return {
        ...request,
        request: { ...request.request, actionDescription: TRANSCRIPT_OMITTED_MESSAGE },
      };
    case 'cost_approval':
      return { ...request, prediction: projectCostApprovalPrompt(request.prediction) };
    case 'task_review':
      return { ...request, request: projectTaskReviewPrompt(request.request) };
    case 'recovery_needed':
      return { ...request, issue: projectIpcRecoveryPrompt(request.issue) };
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

function projectIpcRecoveryPrompt(
  issue: Extract<IpcPromptRequest, { kind: 'recovery_needed' }>['issue'],
): Extract<IpcPromptRequest, { kind: 'recovery_needed' }>['issue'] {
  return {
    ...issue,
    ...(issue.taskTitle !== undefined && { taskTitle: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectClarificationQuestion(question: ClarificationQuestion): ClarificationQuestion {
  switch (question.type) {
    case 'choice':
      return {
        id: question.id,
        type: question.type,
        text: TRANSCRIPT_OMITTED_MESSAGE,
        options: question.options.map(omittedText),
        ...(question.default !== undefined && { default: TRANSCRIPT_OMITTED_MESSAGE }),
      };
    case 'input':
      return {
        id: question.id,
        type: question.type,
        text: TRANSCRIPT_OMITTED_MESSAGE,
        ...(question.default !== undefined && { default: TRANSCRIPT_OMITTED_MESSAGE }),
      };
    case 'confirm':
      return {
        id: question.id,
        type: question.type,
        text: TRANSCRIPT_OMITTED_MESSAGE,
        ...(question.default !== undefined && { default: question.default }),
      };
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

function projectCostApprovalPrompt(
  prediction: Extract<IpcPromptRequest, { kind: 'cost_approval' }>['prediction'],
): Extract<IpcPromptRequest, { kind: 'cost_approval' }>['prediction'] {
  const event = protectEngineEventForConsumer(
    { type: 'cost_prediction', ts: Date.now(), phase: 'planning', prediction },
    { context: 'ipc', persistTranscript: false },
  );
  return event?.type === 'cost_prediction' ? event.prediction : prediction;
}

function projectTaskReviewPrompt(
  request: Extract<IpcPromptRequest, { kind: 'task_review' }>['request'],
): Extract<IpcPromptRequest, { kind: 'task_review' }>['request'] {
  const event = protectEngineEventForConsumer(
    { type: 'task_review_needed', ts: Date.now(), phase: 'idle', ...request },
    { context: 'ipc', persistTranscript: false },
  );
  if (event?.type !== 'task_review_needed') return request;
  return {
    taskId: event.taskId,
    taskTitle: event.taskTitle,
    status: event.status,
    filesTouched: event.filesTouched,
    validation: event.validation,
    evidence: event.evidence,
    cost: event.cost,
    ...(event.routing !== undefined && { routing: event.routing }),
    ...(event.recovery !== undefined && { recovery: event.recovery }),
    availableCommands: event.availableCommands,
  };
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}

function writeOversizeWarning(socket: Socket, msg: ServerMessage): void {
  const detail = msg.kind === 'event' ? msg.payload.type : msg.kind;
  const warning: ServerMessage = {
    kind: 'event',
    payload: {
      type: 'warning',
      ts: Date.now(),
      phase: 'idle',
      message: `IPC: dropped oversized ${detail} frame exceeding ${IPC_MAX_FRAME_BYTES} bytes`,
    },
  };
  try {
    socket.write(JSON.stringify(warning) + '\n');
  } catch {
    // socket may have closed mid-write; ignore
  }
}
