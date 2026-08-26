import type { EngineEvent } from '../../engine/events/types.js';
import { RecoveryIssueSchema } from '../../core/schemas/recovery/schemas.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import {
  CALL_CONSUMER_REDACTION_MARKER,
  protectConsumerPayload,
} from '../../core/consumer-policy.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import {
  projectCostPredictionForTranscriptPolicy,
  projectUserEditConflictForTranscriptPolicy,
  protectEngineEventForConsumer,
} from '../../engine/events/protection/protect.js';
import { projectRecoveryIssueForTranscriptPolicy } from '../../engine/events/public-json.js';
import { userEditConflictSchema } from '../../engine/events/schema.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import { redactSecretsWithMetadata } from '../../utils/redact.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { isRecord } from '../../utils/type-guards.js';
import { isArtifactApprovalStatus } from './gates.js';
import { RPC_MAX_FRAME_BYTES, RPC_MAX_PENDING_OUTPUT_BYTES } from './types.js';
import type { RpcResponse } from './types.js';

export interface RpcErrorOptions {
  transcriptSensitive?: boolean | undefined;
  summary?: string | undefined;
  data?: unknown;
}

export function createResponseWriter(deps: {
  stream: NodeJS.WritableStream;
  onClose: (reason: string) => void;
  getPersistTranscript?: (() => boolean) | undefined;
  maxPendingBytes?: number | undefined;
}) {
  const maxPendingBytes = Number.isFinite(deps.maxPendingBytes)
    ? Math.max(0, Math.floor(deps.maxPendingBytes ?? 0))
    : RPC_MAX_PENDING_OUTPUT_BYTES;
  let broken = false;
  let pendingBytes = 0;
  let current: { frame: string; bytes: number } | null = null;
  let waitingForDrain = false;
  let drainHandler: (() => void) | null = null;
  const queue: Array<{ frame: string; bytes: number }> = [];

  function closeWriter(reason: string): void {
    if (broken) return;
    broken = true;
    pendingBytes = 0;
    current = null;
    queue.length = 0;
    if (drainHandler !== null) {
      deps.stream.removeListener('drain', drainHandler);
      drainHandler = null;
    }
    waitingForDrain = false;
    deps.onClose(reason);
  }

  deps.stream.on('error', (err) => {
    closeWriter(`output stream error: ${String(err)}`);
  });

  deps.stream.on('close', () => {
    closeWriter('output stream closed');
  });

  function pump(): void {
    if (broken || current !== null || waitingForDrain) return;
    while (!broken && current === null && !waitingForDrain) {
      const next = queue.shift();
      if (next === undefined) return;
      current = next;
      let accepted: boolean;
      try {
        accepted = deps.stream.write(next.frame);
      } catch {
        closeWriter('output stream write failed');
        return;
      }
      if (broken) return;
      if (!accepted) {
        waitingForDrain = true;
        const onDrain = () => {
          if (drainHandler !== onDrain) return;
          drainHandler = null;
          waitingForDrain = false;
          if (current !== null) {
            pendingBytes -= current.bytes;
            current = null;
          }
          pump();
        };
        drainHandler = onDrain;
        deps.stream.once('drain', onDrain);
        return;
      }
      pendingBytes -= next.bytes;
      current = null;
    }
  }

  function write(response: RpcResponse): boolean {
    if (broken) return false;
    let serialized: string | undefined;
    try {
      const protectedResponse = protectConsumerPayload({ context: 'rpc', payload: response });
      const output = protectedResponse.oversized
        ? {
            type: 'error',
            error: `omitted oversized ${response.type} response exceeding ${protectedResponse.maxBytes} bytes`,
          }
        : protectedResponse.payload;
      serialized = JSON.stringify(output);
    } catch {
      return false;
    }
    if (serialized === undefined) return false;
    return writeSerialized(serialized);
  }

  function writeSerialized(serialized: string): boolean {
    if (broken) return false;
    const frame = `${serialized}\n`;
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (pendingBytes + bytes > maxPendingBytes) {
      closeWriter(`pending RPC output exceeded ${maxPendingBytes} bytes`);
      return false;
    }
    queue.push({ frame, bytes });
    pendingBytes += bytes;
    pump();
    return true;
  }

  function writeArtifactApprovalStatus(data: unknown, persistTranscript: boolean): boolean {
    if (!isArtifactApprovalStatus(data)) return false;
    try {
      const { review, ...status } = data;
      const protectedReview = protectArtifactReview(review);
      const protectedResponse = protectConsumerPayload({
        context: 'rpc',
        payload: { type: 'status', data: protectStatusData(status, persistTranscript) },
      });
      if (
        protectedResponse.oversized ||
        !isRecord(protectedResponse.payload) ||
        protectedResponse.payload.type !== 'status' ||
        !isRecord(protectedResponse.payload.data)
      ) {
        return false;
      }
      const serialized = JSON.stringify({
        type: 'status',
        data: { ...protectedResponse.payload.data, review: protectedReview },
      });
      if (
        serialized === undefined ||
        Buffer.byteLength(`${serialized}\n`, 'utf8') > RPC_MAX_FRAME_BYTES
      ) {
        return false;
      }
      return writeSerialized(serialized);
    } catch {
      return false;
    }
  }

  return {
    ack(command: string, data?: unknown): void {
      write({ type: 'ack', command, data: protectAckData(command, data, persistTranscript()) });
    },
    error(message: string, options: RpcErrorOptions = {}): void {
      const persist = persistTranscript();
      write({
        type: 'error',
        error: protectErrorMessage(message, options, persist),
        ...(options.data !== undefined && { data: protectStatusData(options.data, persist) }),
      });
    },
    status(data: unknown): boolean {
      const persist = persistTranscript();
      if (isArtifactApprovalStatus(data)) {
        return writeArtifactApprovalStatus(data, persist);
      }
      if (isRecord(data) && data.approvalType === 'artifact') return false;
      return write({ type: 'status', data: protectStatusData(data, persist) });
    },
    event(engineEvent: EngineEvent): void {
      const protectedEvent = protectEngineEventForConsumer(engineEvent, {
        context: 'rpc',
        persistTranscript: persistTranscript(),
      });
      if (protectedEvent !== null) write({ type: 'event', data: protectedEvent });
    },
  };

  function persistTranscript(): boolean {
    return deps.getPersistTranscript?.() ?? true;
  }
}

function protectArtifactReview(review: ArtifactApprovalReview): ArtifactApprovalReview {
  const textWithoutTerminalControls = review.text
    .split('\u0000')
    .map((part) => stripTerminalControls(part, { preserveLineBreaks: true }))
    .join('\u0000');
  return {
    ...review,
    text: redactSecretsWithMetadata(textWithoutTerminalControls, {
      marker: CALL_CONSUMER_REDACTION_MARKER,
    }).text,
  };
}

function protectAckData(command: string, data: unknown, persistTranscript: boolean): unknown {
  if (persistTranscript || command !== 'slash' || !isRecord(data)) return data;

  const output: Record<string, unknown> = { ...data };
  if (typeof output.command === 'string') {
    output.command = ackCommandName(output.command);
  }
  if (Array.isArray(output.messages)) {
    output.messages = output.messages.map(omittedMessage);
  }
  return output;
}

function ackCommandName(raw: string): string {
  const trimmed = raw.trim();
  const firstWhitespace = trimmed.search(/\s/);
  return firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
}

function protectErrorMessage(
  message: string,
  options: RpcErrorOptions,
  persistTranscript: boolean,
): string {
  if (persistTranscript || options.transcriptSensitive !== true) return message;
  return options.summary ?? TRANSCRIPT_OMITTED_MESSAGE;
}

function protectStatusData(data: unknown, persistTranscript: boolean): unknown {
  if (persistTranscript || !isRecord(data)) return data;

  let omittedTranscript = false;
  const output: Record<string, unknown> = { ...data };
  for (const key of ['state', 'question', 'partialResponse', 'request']) {
    if (key in output) {
      output[key] = key === 'state' ? null : TRANSCRIPT_OMITTED_MESSAGE;
      omittedTranscript = true;
    }
  }
  if ('issue' in output) {
    const issue = RecoveryIssueSchema.safeParse(output.issue);
    output.issue = issue.success
      ? projectRecoveryIssueForTranscriptPolicy(issue.data, false)
      : TRANSCRIPT_OMITTED_MESSAGE;
    omittedTranscript = true;
  }
  if ('prediction' in output) {
    const prediction = CostPredictionSchema.safeParse(output.prediction);
    output.prediction = prediction.success
      ? projectCostPredictionForTranscriptPolicy(prediction.data, false)
      : TRANSCRIPT_OMITTED_MESSAGE;
    omittedTranscript = true;
  }
  if ('conflict' in output) {
    const conflict = userEditConflictSchema.safeParse(output.conflict);
    output.conflict = conflict.success
      ? projectUserEditConflictForTranscriptPolicy(conflict.data, false)
      : TRANSCRIPT_OMITTED_MESSAGE;
    omittedTranscript = true;
  }
  return omittedTranscript ? { ...output, transcript: TRANSCRIPT_OMITTED_MESSAGE } : output;
}

function omittedMessage(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}
