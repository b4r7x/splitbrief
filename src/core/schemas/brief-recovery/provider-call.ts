import { z } from 'zod';
import {
  OwnedPlannerArtifactSchema,
  TaskCompilationAttemptIdSchema,
  TaskCompilationBatchIdSchema,
  TaskCompilationFailureCodeSchema,
  TaskCompilationFailureSchema,
  TaskCompilationFailureStatusSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  TaskCompilationProgramSchema,
} from '../task-compilation.js';
import { RecoveryUsageSchema } from './budget.js';
import {
  DispatchPossibilitySchema,
  MAX_ATTEMPTS,
  MAX_BRIEF,
  hash,
  id,
  path,
} from './primitives.js';

const recoveryProviderCallSelectionSchema = z
  .object({
    batchId: TaskCompilationBatchIdSchema,
    attemptId: TaskCompilationAttemptIdSchema,
    envelopeDigest: hash,
  })
  .strict();

export const RecoveryProviderAggregateRequestSchema = z
  .object({
    operationId: TaskCompilationOperationIdSchema,
    program: TaskCompilationProgramSchema,
    calls: z.array(recoveryProviderCallSelectionSchema).min(1).max(MAX_ATTEMPTS).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.calls.length !== value.program.batches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'aggregate recovery calls must cover every frozen program batch',
      });
    }
    const batchIds = new Set<string>();
    for (const [index, batch] of value.program.batches.entries()) {
      if (batchIds.has(batch.batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['program', 'batches', index, 'batchId'],
          message: 'frozen program batches must have unique IDs',
        });
      }
      batchIds.add(batch.batchId);
    }
    const seenBatches = new Set<string>();
    const seenAttempts = new Set<string>();
    for (const [index, call] of value.calls.entries()) {
      const batchId = call.batchId;
      if (!batchIds.has(call.batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'batchId'],
          message: 'aggregate call batch is not present in the frozen program',
        });
      }
      if (seenBatches.has(batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'batchId'],
          message: 'aggregate recovery calls must not repeat a batch',
        });
      }
      if (seenAttempts.has(call.attemptId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'attemptId'],
          message: 'aggregate recovery calls must not repeat an attempt',
        });
      }
      seenBatches.add(batchId);
      seenAttempts.add(call.attemptId);
    }
  })
  .strict();
export type RecoveryProviderAggregateRequest = z.infer<
  typeof RecoveryProviderAggregateRequestSchema
>;

const recoveryProviderCallIdentityShape = {
  operationId: TaskCompilationOperationIdSchema,
  programId: TaskCompilationProgramIdSchema,
  batchId: TaskCompilationBatchIdSchema,
  attemptId: TaskCompilationAttemptIdSchema,
  envelopeDigest: hash,
} as const;
const definiteFailureTerminalStatusSchema = TaskCompilationFailureStatusSchema.exclude(['unknown']);

export const RecoveryProviderCallResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('not-dispatched'),
      artifact: z.null(),
      usage: z.null(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('completed'),
      terminalStatus: z.literal('completed'),
      artifact: OwnedPlannerArtifactSchema,
      usage: RecoveryUsageSchema.nullable(),
      failureCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('failed'),
      terminalStatus: definiteFailureTerminalStatusSchema,
      artifact: z.null(),
      usage: RecoveryUsageSchema.nullable(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('unknown'),
      terminalStatus: z.literal('unknown'),
      artifact: z.null(),
      usage: RecoveryUsageSchema.nullable(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
]);
export type RecoveryProviderCallResult = z.infer<typeof RecoveryProviderCallResultSchema>;

const recoveryProviderResultBaseShape = {
  operationId: TaskCompilationOperationIdSchema,
  programId: TaskCompilationProgramIdSchema,
  operationEnvelopeDigest: hash,
  calls: z.array(RecoveryProviderCallResultSchema).min(1).max(MAX_ATTEMPTS).readonly(),
} as const;

const recoveryProviderAggregateResultSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...recoveryProviderResultBaseShape,
        kind: z.literal('compiled'),
        candidate: z.unknown(),
        usage: RecoveryUsageSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...recoveryProviderResultBaseShape,
        kind: z.enum(['definite-failure', 'ambiguous-failure']),
        failure: TaskCompilationFailureSchema,
        usage: RecoveryUsageSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const seenAttempts = new Set<string>();
    for (const [index, call] of value.calls.entries()) {
      if (call.operationId !== value.operationId || call.programId !== value.programId) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index],
          message: 'aggregate result call identity must match its result',
        });
      }
      if (seenAttempts.has(call.attemptId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'attemptId'],
          message: 'aggregate result attempts must be unique',
        });
      }
      seenAttempts.add(call.attemptId);
      if (call.kind === 'completed') {
        const artifact = call.artifact;
        if (
          artifact.programId !== value.programId ||
          artifact.batchId !== call.batchId ||
          artifact.attemptId !== call.attemptId
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['calls', index, 'artifact'],
            message: 'completed artifact identity must match its call result',
          });
        }
      }
    }
    if (value.kind === 'compiled') {
      if (value.candidate === null || typeof value.candidate !== 'object') {
        ctx.addIssue({
          code: 'custom',
          path: ['candidate'],
          message: 'compiled aggregate results require a materialized candidate',
        });
      }
      if (value.calls.some((call) => call.kind !== 'completed')) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls'],
          message: 'compiled aggregate results require every call to complete',
        });
      }
      return;
    }
    const hasUnknown = value.calls.some((call) => call.kind === 'unknown');
    if (value.kind === 'ambiguous-failure' && !hasUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'ambiguous aggregate failures require an unknown call result',
      });
    }
    if (value.kind === 'definite-failure' && hasUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'definite aggregate failures cannot contain unknown call results',
      });
    }
  });
export type RecoveryProviderAggregateResult = z.infer<typeof recoveryProviderAggregateResultSchema>;

function recoveryProviderCallIdentityKey(call: {
  batchId: string;
  attemptId: string;
  envelopeDigest: string;
}): string {
  return JSON.stringify([call.batchId, call.attemptId, call.envelopeDigest]);
}

function refineRecoveryProviderAggregateResultForRequest(
  result: RecoveryProviderAggregateResult,
  request: RecoveryProviderAggregateRequest,
  ctx: z.RefinementCtx,
): void {
  if (result.operationId !== request.operationId) {
    ctx.addIssue({
      code: 'custom',
      path: ['operationId'],
      message: 'aggregate result operation ID must match the frozen request',
    });
  }
  if (result.programId !== request.program.programId) {
    ctx.addIssue({
      code: 'custom',
      path: ['programId'],
      message: 'aggregate result program ID must match the frozen request',
    });
  }
  if (result.operationEnvelopeDigest !== request.program.operationEnvelope.callsDigest) {
    ctx.addIssue({
      code: 'custom',
      path: ['operationEnvelopeDigest'],
      message: 'aggregate result operation envelope must match the frozen request',
    });
  }

  const expectedByBatch = new Map(request.calls.map((call) => [call.batchId, call] as const));
  const expectedKeys = new Set(request.calls.map(recoveryProviderCallIdentityKey));
  const seenKeys = new Set<string>();
  const seenBatches = new Set<string>();

  for (const [index, call] of result.calls.entries()) {
    const key = recoveryProviderCallIdentityKey(call);
    if (seenKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index],
        message: 'aggregate result call identities must be unique',
      });
    }
    seenKeys.add(key);

    const expected = expectedByBatch.get(call.batchId);
    if (expected === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'batchId'],
        message: 'aggregate result batch is not present in the frozen request',
      });
      continue;
    }
    if (seenBatches.has(call.batchId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'batchId'],
        message: 'aggregate result batches must be one-to-one with the frozen request',
      });
    }
    seenBatches.add(call.batchId);
    if (call.attemptId !== expected.attemptId) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'attemptId'],
        message: 'aggregate result attempt must match the frozen request',
      });
    }
    if (call.envelopeDigest !== expected.envelopeDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'envelopeDigest'],
        message: 'aggregate result envelope must match the frozen request',
      });
    }
  }

  for (const [index, expected] of request.calls.entries()) {
    if (!seenKeys.has(recoveryProviderCallIdentityKey(expected))) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: `aggregate result is missing frozen call ${index + 1}`,
      });
    }
  }
  for (const key of seenKeys) {
    if (!expectedKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'aggregate result contains an unexpected frozen call identity',
      });
      break;
    }
  }
}

export function createRecoveryProviderAggregateResultSchema(
  request: RecoveryProviderAggregateRequest,
) {
  return recoveryProviderAggregateResultSchema.superRefine((result, ctx) => {
    refineRecoveryProviderAggregateResultForRequest(result, request, ctx);
  });
}

export const RecoveryProviderRequestSchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    requestId: id,
    prompt: z.string().max(MAX_BRIEF),
    projectDir: path,
    signal: z.unknown().optional(),
  })
  .strict();
export type RecoveryProviderRequest = z.infer<typeof RecoveryProviderRequestSchema>;

export const RecoveryProviderResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('completed'),
      requestId: id.nullable(),
      dispatchPossibility: z.literal('possible'),
      remoteObservation: z.literal('confirmed-final'),
      text: z.string().max(MAX_BRIEF),
      providerCode: id.nullable(),
      usage: RecoveryUsageSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('definite-failure'),
      requestId: id.nullable(),
      dispatchPossibility: DispatchPossibilitySchema,
      remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
      text: z.null(),
      providerCode: id,
      usage: RecoveryUsageSchema.nullable(),
    })
    .superRefine((value, ctx) => {
      if (value.dispatchPossibility === 'none' && value.remoteObservation !== 'not-dispatched') {
        ctx.addIssue({
          code: 'custom',
          path: ['remoteObservation'],
          message: 'definite dispatch mismatch',
        });
      }
      if (
        value.dispatchPossibility === 'possible' &&
        value.remoteObservation !== 'confirmed-final'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['remoteObservation'],
          message: 'definite dispatch mismatch',
        });
      }
    })
    .strict(),
  z
    .object({
      kind: z.literal('ambiguous-failure'),
      requestId: id,
      dispatchPossibility: z.literal('possible'),
      remoteObservation: z.literal('unknown'),
      text: z.null(),
      providerCode: id,
      usage: RecoveryUsageSchema.nullable(),
    })
    .strict(),
]);
export type RecoveryProviderResult = z.infer<typeof RecoveryProviderResultSchema>;

export type BriefRecoveryProviderPort = {
  dispatch(input: RecoveryProviderRequest): Promise<RecoveryProviderResult>;
};
