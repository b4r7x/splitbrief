import { z } from 'zod';
import { readSavedRecoveryActions } from '../../core/schemas/recovery/schemas.js';
import { isRecord } from '../../utils/type-guards.js';
import { ApprovalEventSchemas } from './payloads/approval.js';
import { BuildEventSchemas } from './payloads/build.js';
import { phaseEvent } from './payloads/fields.js';
import { PlannerEventSchemas } from './payloads/planner.js';
import { QueueEventSchemas } from './payloads/queue.js';
import { RecoveryEventSchemas } from './payloads/recovery.js';
import { ReviewEventSchemas } from './payloads/review.js';
import { RunnerCallEventSchemas } from './payloads/runner-call.js';
import { SeatEventSchemas } from './payloads/seat.js';
import { TaskEventSchemas } from './payloads/task.js';
import { WorkflowEventSchemas } from './payloads/workflow.js';

function operationalMessageEvent<
  T extends 'debug' | 'info' | 'warning' | 'error',
  S extends z.ZodRawShape,
>(type: T, shape: S) {
  const base = phaseEvent(type).extend({
    ...shape,
    message: z.string(),
    category: z.undefined().optional(),
    code: z.undefined().optional(),
  });
  const safe = phaseEvent(type).extend({
    ...shape,
    message: z.string(),
    category: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
  });
  return z.union([safe, base]);
}

/**
 * On the row of an attempt revert, a brief restore or a denied write: the files a put-back of the
 * running brief still acts on. The stop sheet promises no kept change while it is 0.
 */
const briefKept = z.number().int().nonnegative().optional();

/** A state the run handled by itself: the session log keeps it; the screen and stderr do not. */
const OperationalDebugEventSchema = operationalMessageEvent('debug', {});
const OperationalInfoEventSchema = operationalMessageEvent('info', { briefKept });
const OperationalWarningEventSchema = operationalMessageEvent('warning', { briefKept });
const OperationalErrorEventSchema = operationalMessageEvent('error', {
  briefKept,
  /** When a usage-limit halt's quota comes back, as the ISO instant its `resetAt` names. */
  resetAt: z.string().optional(),
});

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function parseOperationalMessageEvent(value: unknown): EngineEventFromPayloadSchemas | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'debug':
      return parseWithSchema(OperationalDebugEventSchema, value);
    case 'info':
      return parseWithSchema(OperationalInfoEventSchema, value);
    case 'warning':
      return parseWithSchema(OperationalWarningEventSchema, value);
    case 'error':
      return parseWithSchema(OperationalErrorEventSchema, value);
    default:
      return null;
  }
}

function parseEngineEventPayload(value: unknown): EngineEventFromPayloadSchemas | null {
  const operationalMessage = parseOperationalMessageEvent(value);
  if (operationalMessage !== null) return operationalMessage;

  return parseWithSchema(EngineEventPayloadSchema, readSavedRecoveryEvent(value));
}

/** A logged recovery event names its actions in today's vocabulary; see `readSavedRecoveryActions`. */
function readSavedRecoveryEvent(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('recovery_')) {
    return value;
  }
  return readSavedRecoveryActions(value);
}

function invalidEngineEventMessage(value: unknown): string {
  const type = isRecord(value) && typeof value.type === 'string' ? ` "${value.type}"` : '';
  return `Invalid engine event${type}`;
}

const EngineEventPayloadSchema = z.discriminatedUnion('type', [
  ...WorkflowEventSchemas,
  ...RecoveryEventSchemas,
  ...PlannerEventSchemas,
  ...RunnerCallEventSchemas,
  ...TaskEventSchemas,
  ...BuildEventSchemas,
  ...ReviewEventSchemas,
  ...SeatEventSchemas,
  ...QueueEventSchemas,
  ...ApprovalEventSchemas,
]);

type EngineEventFromPayloadSchemas =
  | z.infer<typeof EngineEventPayloadSchema>
  | z.infer<typeof OperationalDebugEventSchema>
  | z.infer<typeof OperationalInfoEventSchema>
  | z.infer<typeof OperationalWarningEventSchema>
  | z.infer<typeof OperationalErrorEventSchema>;

export const EngineEventSchema = z
  .unknown()
  .transform((value, ctx): EngineEventFromPayloadSchemas => {
    const parsed = parseEngineEventPayload(value);
    if (parsed !== null) return parsed;
    ctx.addIssue({ code: 'custom', path: [], message: invalidEngineEventMessage(value) });
    return z.NEVER;
  });

type EngineEventFromSchema = z.infer<typeof EngineEventSchema>;

export function parseEngineEvent(value: unknown): EngineEventFromSchema | null {
  const result = EngineEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
