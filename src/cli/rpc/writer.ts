import type { EngineEvent } from '../../engine/events/types.js';
import { RecoveryIssueSchema } from '../../core/schemas/recovery.js';
import { protectConsumerPayload } from '../../engine/calls/consumer-policy.js';
import {
  protectEngineEventForConsumer,
  TRANSCRIPT_OMITTED_MESSAGE,
} from '../../engine/events/protection.js';
import { projectRecoveryIssueForTranscriptPolicy } from '../../engine/events/public-json.js';
import { isRecord } from '../../utils/type-guards.js';
import type { RpcResponse } from './types.js';

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

  function write(response: RpcResponse): void {
    if (broken) return;
    try {
      const protectedResponse = protectConsumerPayload({ context: 'rpc', payload: response });
      const output = protectedResponse.oversized
        ? {
            type: 'error',
            error: `omitted oversized ${response.type} response exceeding ${protectedResponse.maxBytes} bytes`,
          }
        : protectedResponse.payload;
      deps.stream.write(`${JSON.stringify(output)}\n`);
    } catch {
      broken = true;
      deps.onClose('output stream write failed');
    }
  }

  return {
    ack(command: string, data?: unknown): void {
      write({ type: 'ack', command, data });
    },
    error(message: string): void {
      write({ type: 'error', error: message });
    },
    status(data: unknown): void {
      write({ type: 'status', data: protectStatusData(data, persistTranscript()) });
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

function protectStatusData(data: unknown, persistTranscript: boolean): unknown {
  if (persistTranscript || !isRecord(data)) return data;

  let omittedTranscript = false;
  const output: Record<string, unknown> = { ...data };
  for (const key of ['state', 'question', 'partialResponse', 'conflict', 'request']) {
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
  return omittedTranscript ? { ...output, transcript: TRANSCRIPT_OMITTED_MESSAGE } : output;
}
