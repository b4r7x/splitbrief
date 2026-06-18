import { protectConsumerPayload, type CallConsumerContext } from '../calls/consumer-policy.js';
import { EngineEventSchema, eventPhase } from './schema.js';
import type { EngineEvent, EngineEventOf } from './types.js';

export const TRANSCRIPT_OMITTED_MESSAGE = '[transcript omitted]';

interface EngineEventProtectionOptions {
  context: CallConsumerContext;
  persistTranscript: boolean;
}

const DROPPED_TRANSCRIPT_EVENT_TYPES = new Set<EngineEvent['type']>([
  'planner_text',
  'user_message',
  'clarifications_collected',
  'clarification_answered',
  'implementer_generate_done',
  'runner_call_text_delta',
  'runner_call_tool_use',
  'runner_call_artifact',
]);

export function protectEngineEventForConsumer(
  event: EngineEvent,
  opts: EngineEventProtectionOptions,
): EngineEvent | null {
  const transcriptSafeEvent = applyTranscriptPersistencePolicy(event, opts.persistTranscript);
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

  const parsed = EngineEventSchema.safeParse(protectedPayload.payload);
  if (parsed.success) return parsed.data;

  return protectionWarning(
    event,
    `${opts.context}: omitted invalid ${event.type} event after public payload normalization`,
  );
}

function applyTranscriptPersistencePolicy(
  event: EngineEvent,
  persistTranscript: boolean,
): EngineEvent | null {
  if (persistTranscript) return event;
  if (DROPPED_TRANSCRIPT_EVENT_TYPES.has(event.type)) return null;

  switch (event.type) {
    case 'runner_call_warning':
      return {
        ...event,
        warning: { ...event.warning, message: TRANSCRIPT_OMITTED_MESSAGE },
      };
    case 'runner_call_error':
      return {
        ...event,
        error: { ...event.error, message: TRANSCRIPT_OMITTED_MESSAGE },
      };
    case 'warning':
    case 'error':
      return { ...event, message: TRANSCRIPT_OMITTED_MESSAGE };
    default:
      return event;
  }
}

function protectionWarning(event: EngineEvent, message: string): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: event.ts,
    phase: eventPhase(event) ?? 'idle',
    message,
  };
}
