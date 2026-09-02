import { z } from 'zod';

export const MAX_RECOVERY_RECORD_BYTES = 64 * 1024;
export const MAX_RECOVERY_PAYLOAD_BYTES = 256 * 1024;
const MAX_RECOVERY_RECORDS = 1_000_000;
export const MAX_RECOVERY_REFS = 64;
export const MAX_RECOVERY_OUTBOX = 256;

export const recoveryIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const recoveryHash = z.string().regex(/^[a-f0-9]{64}$/u);
export const recoveryPath = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\\]+$/u)
  .refine((value) => !value.split('/').includes('..'), {
    message: 'recovery path must not contain parent traversal',
  });
export const recoveryKind = z.enum([
  'initial-result',
  'auto-repair-exhausted',
  'receipt',
  'outcome',
  'provider-failure',
  'storage-failure',
  'input-disposition',
  'rejection',
  'reservation',
  'usage-reconciliation',
  'no-progress',
  'terminal-accounting',
  'epoch-closed',
  'late-result',
  'late-usage',
  'replay',
]);

export type RecoveryEvidenceKind = z.infer<typeof recoveryKind>;

export const recoveryReferenceSchema = z.strictObject({
  revision: z.literal(1),
  hash: recoveryHash,
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\\]+$/u)
    .refine((value) => !value.split('/').includes('..'), {
      message: 'recovery evidence path must not contain parent traversal',
    }),
});

export type RecoveryEvidenceRef = z.infer<typeof recoveryReferenceSchema>;

export const recoveryCheckpointSchema = z.strictObject({
  stateRevision: z.number().int().nonnegative().max(MAX_RECOVERY_RECORDS),
  recoveryRevision: z.number().int().nonnegative().max(MAX_RECOVERY_RECORDS),
  status: z.string().min(1).max(128),
  activeOperationId: recoveryIdentifier.nullable(),
  evidenceHead: recoveryHash,
});

export type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;

export const recoveryRecordSchema = z.strictObject({
  version: z.literal(1),
  sessionId: recoveryIdentifier,
  epochId: recoveryIdentifier,
  sequence: z.number().int().positive().max(MAX_RECOVERY_RECORDS),
  prevHash: recoveryHash.nullable(),
  recordHash: recoveryHash,
  eventId: recoveryIdentifier,
  kind: recoveryKind,
  operationId: recoveryIdentifier.optional(),
  payloadRef: recoveryPath,
  refs: z.array(z.string().min(1).max(2048)).max(MAX_RECOVERY_REFS),
  after: recoveryCheckpointSchema.nullable(),
});

export type RecoveryEvidenceRecord = z.infer<typeof recoveryRecordSchema>;

export const recoveryManifestSchema = z.strictObject({
  version: z.literal(1),
  sessionId: recoveryIdentifier,
  epochId: recoveryIdentifier,
  disposition: z.enum(['continued', 'approved', 'rejected']),
  closedAt: z.string().min(1).max(128),
  headHash: recoveryHash,
  journalHead: recoveryHash,
  sidecarNamespace: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[^\\]+$/u),
  outbox: z
    .array(
      z.strictObject({
        eventId: recoveryIdentifier,
        payloadRef: recoveryPath,
        acknowledged: z.boolean(),
      }),
    )
    .max(MAX_RECOVERY_OUTBOX),
  manifestHash: recoveryHash,
});

export type RecoveryEpochManifest = z.infer<typeof recoveryManifestSchema>;

export type RecoveryOutboxEntry = Readonly<{
  eventId: string;
  payloadRef: string;
  acknowledged: boolean;
}>;

export type RecoverySidecarKind = 'late-result' | 'late-usage' | 'replay';
