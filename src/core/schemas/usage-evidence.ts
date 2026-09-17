import { z } from 'zod';
import {
  RUNNER_CALL_BACKEND_KINDS,
  RUNNER_CALL_ROLES,
  RunnerCallUsageContractSchema,
} from '../runner-call-contract.js';
import { InvocationIdentitySchema } from './invocation-identity.js';
import { PhaseSchema } from './enums.js';
import { TaskIdSchema } from './task.js';

/**
 * What one call's usage covers. `single-request` is recorded only by the owner
 * of one concrete provider request; a CLI invocation may hold many requests and
 * is `aggregate`; a record that names no boundary is `unknown`.
 */
export const USAGE_BOUNDARIES = ['single-request', 'aggregate', 'unknown'] as const;
export const UsageBoundarySchema = z.enum(USAGE_BOUNDARIES);
/** @public */
export type UsageBoundary = z.infer<typeof UsageBoundarySchema>;

export const CallUsageEvidenceSchema = z.strictObject({
  callId: z.string().min(1).max(128),
  taskId: TaskIdSchema.optional(),
  attempt: z.number().int().nonnegative().optional(),
  role: z.enum(RUNNER_CALL_ROLES),
  /** Needed to distinguish planning-time review calls from the review seat. */
  phase: PhaseSchema.optional(),
  backendKind: z.enum(RUNNER_CALL_BACKEND_KINDS),
  runnerName: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  usageBoundary: UsageBoundarySchema,
  invocationIdentity: InvocationIdentitySchema.optional(),
  usage: RunnerCallUsageContractSchema.nullable(),
});
export type CallUsageEvidence = z.infer<typeof CallUsageEvidenceSchema>;
