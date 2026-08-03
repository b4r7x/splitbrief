import type { EngineEvent } from '../../engine/events/types.js';
import { RecoveryIssueSchema } from '../../core/schemas/recovery/schemas.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import { protectConsumerPayload } from '../../core/consumer-policy.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import {
  projectCostPredictionForTranscriptPolicy,
  projectUserEditConflictForTranscriptPolicy,
  protectEngineEventForConsumer,
} from '../../engine/events/protection/protect.js';
import { projectRecoveryIssueForTranscriptPolicy } from '../../engine/events/public-json.js';
import { userEditConflictSchema } from '../../engine/events/schema.js';
import { isRecord } from '../../utils/type-guards.js';
import { isArtifactApprovalStatus } from './gates.js';
import { RPC_MAX_FRAME_BYTES } from './types.js';
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
}) {
  let broken = false;

  deps.stream.on('error', (err) => {
    if (broken) return;
    broken = true;
    deps.onClose(`output stream error: ${String(err)}`);
  });

  deps.stream.on('close', () => {
    if (broken) return;
    broken = true;
    deps.onClose('output stream closed');
  });

  function write(response: RpcResponse): boolean {
    if (broken) return false;
    try {
      const protectedResponse = protectConsumerPayload({ context: 'rpc', payload: response });
      const output = protectedResponse.oversized
        ? {
            type: 'error',
            error: `omitted oversized ${response.type} response exceeding ${protectedResponse.maxBytes} bytes`,
          }
        : protectedResponse.payload;
      const serialized = JSON.stringify(output);
      if (serialized === undefined) return false;
      return writeSerialized(serialized);
    } catch {
      broken = true;
      deps.onClose('output stream write failed');
      return false;
    }
  }

  function writeSerialized(serialized: string): boolean {
    if (broken) return false;
    try {
      deps.stream.write(`${serialized}\n`);
      return true;
    } catch {
      broken = true;
      deps.onClose('output stream write failed');
      return false;
    }
  }

  function writeArtifactApprovalStatus(data: unknown, persistTranscript: boolean): boolean {
    if (!isArtifactApprovalStatus(data)) return false;
    try {
      const { review, ...status } = data;
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
        data: { ...protectedResponse.payload.data, review },
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
