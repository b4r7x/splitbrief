import { z } from 'zod';
import type { TreeEntryEnvelope } from './schemas.js';
import {
  SessionStartPayloadSchema,
  PlanStepPayloadSchema,
  AgentInvocationPayloadSchema,
  RecoveryDecisionPayloadSchema,
  FileStatePayloadSchema,
  CostCheckpointPayloadSchema,
  BranchSummaryPayloadSchema,
} from './entry-types.js';

type PayloadSchema = z.ZodType<unknown>;

const registry = new Map<string, PayloadSchema>([
  ['session-start', SessionStartPayloadSchema],
  ['plan-step', PlanStepPayloadSchema],
  ['agent-invocation', AgentInvocationPayloadSchema],
  ['recovery-decision', RecoveryDecisionPayloadSchema],
  ['file-state', FileStatePayloadSchema],
  ['cost-checkpoint', CostCheckpointPayloadSchema],
  ['branch-summary', BranchSummaryPayloadSchema],
]);

export function registerEntryType(type: string, schema: PayloadSchema): void {
  registry.set(type, schema);
}

export function hasEntryType(type: string): boolean {
  return registry.has(type);
}

export function getEntrySchema(type: string): PayloadSchema | undefined {
  return registry.get(type);
}

export interface TypedEntry<T = unknown> {
  envelope: TreeEntryEnvelope;
  payload: T;
  valid: true;
}

export interface OpaqueEntry {
  envelope: TreeEntryEnvelope;
  payload: unknown;
  valid: false;
  type: string;
}

export type ParsedEntry = TypedEntry | OpaqueEntry;

export function parseEntry(envelope: TreeEntryEnvelope): ParsedEntry {
  const schema = registry.get(envelope.type);
  if (!schema) {
    return { envelope, payload: envelope.payload, valid: false, type: envelope.type };
  }
  const result = schema.safeParse(envelope.payload);
  if (!result.success) {
    return { envelope, payload: envelope.payload, valid: false, type: envelope.type };
  }
  return { envelope, payload: result.data, valid: true };
}

export function parseEntryAs<T>(envelope: TreeEntryEnvelope, expectedType: string, schema: z.ZodType<T>): TypedEntry<T> | null {
  if (envelope.type !== expectedType) return null;
  const result = schema.safeParse(envelope.payload);
  if (!result.success) return null;
  return { envelope, payload: result.data, valid: true };
}
