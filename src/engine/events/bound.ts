import { boundConsumerPayload, type CallConsumerContext } from '../../core/payload-bounds.js';
import { EngineEventSchema } from './schema.js';
import { eventPhase } from '../../core/event-phase.js';
import type { EngineEvent, EngineEventOf } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

export function boundEngineEventForConsumer(
  event: EngineEvent,
  context: CallConsumerContext,
): EngineEvent {
  const bounded = boundConsumerPayload({ context, payload: event });
  if (bounded.oversized) {
    return boundsWarning(
      event,
      `${context}: omitted oversized ${event.type} event exceeding ${bounded.maxBytes} bytes`,
    );
  }

  const payload = normalizeBoundedEventPayload(event, bounded);
  const parsed = EngineEventSchema.safeParse(payload);
  if (parsed.success) return parsed.data;

  return boundsWarning(
    event,
    `${context}: omitted invalid ${event.type} event after public payload normalization`,
  );
}

function normalizeBoundedEventPayload(
  event: EngineEvent,
  bounded: ReturnType<typeof boundConsumerPayload>,
): unknown {
  if (event.type === 'runner_call_activity' && bounded.redacted && isRecord(bounded.payload)) {
    return { ...bounded.payload, redacted: true };
  }
  return bounded.payload;
}

function boundsWarning(event: EngineEvent, message: string): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: event.ts,
    phase: eventPhase(event) ?? 'idle',
    category: 'payload-bounds',
    code: 'payload_omitted',
    message,
  };
}
