import { protectConsumerPayload, type CallConsumerContext } from '../../../core/consumer-policy.js';
import { EngineEventSchema } from '../schema.js';
import { eventPhase } from '../../../core/event-phase.js';
import type { EngineEvent, EngineEventOf } from '../types.js';
import { isRecord } from '../../../utils/type-guards.js';
import { projectEngineEventForTranscriptPolicy } from './transcript.js';

export {
  projectEngineEventForTranscriptPolicy,
  projectCostPredictionForTranscriptPolicy,
  projectUserEditConflictForTranscriptPolicy,
} from './transcript.js';

interface EngineEventProtectionOptions {
  context: CallConsumerContext;
  persistTranscript: boolean;
}

export function protectEngineEventForConsumer(
  event: EngineEvent,
  opts: EngineEventProtectionOptions,
): EngineEvent | null {
  const transcriptSafeEvent = projectEngineEventForTranscriptPolicy(event, opts.persistTranscript);
  if (transcriptSafeEvent === null) return null;

  const protectedPayload = protectConsumerPayload({
    context: opts.context,
    payload: transcriptSafeEvent,
  });
  if (protectedPayload.oversized) {
    return protectionWarning(
      event,
      `${opts.context}: omitted oversized ${event.type} event exceeding ${protectedPayload.maxBytes} bytes`,
    );
  }

  const payload = normalizeProtectedEventPayload(transcriptSafeEvent, protectedPayload);
  const parsed = EngineEventSchema.safeParse(payload);
  if (parsed.success) return parsed.data;

  return protectionWarning(
    event,
    `${opts.context}: omitted invalid ${event.type} event after public payload normalization`,
  );
}

function normalizeProtectedEventPayload(
  event: EngineEvent,
  protectedPayload: ReturnType<typeof protectConsumerPayload>,
): unknown {
  if (
    event.type === 'runner_call_activity' &&
    protectedPayload.redacted &&
    isRecord(protectedPayload.payload)
  ) {
    return { ...protectedPayload.payload, redacted: true };
  }
  return protectedPayload.payload;
}

function protectionWarning(event: EngineEvent, message: string): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: event.ts,
    phase: eventPhase(event) ?? 'idle',
    category: 'protection',
    code: 'payload_omitted',
    transcriptSafe: true,
    message,
  };
}
