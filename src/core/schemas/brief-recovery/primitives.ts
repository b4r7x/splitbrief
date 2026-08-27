import { z } from 'zod';

export const MAX_ID = 256;
const MAX_MESSAGE = 4_096;
const MAX_PATH = 4_096;
const MAX_HASH = 512;
export const MAX_BRIEF = 1_024 * 1_024;
export const MAX_ISSUES = 256;
export const MAX_ATTEMPTS = 1_024;
export const MAX_INPUTS = 4_096;
export const MAX_HISTORY = 256;
export const MAX_OUTBOX = 4_096;

export const id = z.string().min(1).max(MAX_ID);
export const message = z.string().trim().min(1).max(MAX_MESSAGE);
export const hash = z.string().min(1).max(MAX_HASH);
export const path = z.string().min(1).max(MAX_PATH);
export const timestamp = z.string().min(1).max(128);
export const nonNegativeInteger = z.number().int().nonnegative();
export const finiteAmount = z.number().finite().nonnegative();
export const signedFiniteAmount = z.number().finite();

export const BRIEF_CONTRACT_STATUSES = [
  'checking',
  'auto-repairing',
  'blocked',
  'storage-blocked',
  'retrying',
  'unresolved',
  'ready',
  'readiness-blocked',
  'rejected',
] as const;
export const BriefContractStatusSchema = z.enum(BRIEF_CONTRACT_STATUSES);
export type BriefContractStatus = z.infer<typeof BriefContractStatusSchema>;

export const DISPATCH_POSSIBILITIES = ['none', 'possible'] as const;
export const DispatchPossibilitySchema = z.enum(DISPATCH_POSSIBILITIES);
export type DispatchPossibility = z.infer<typeof DispatchPossibilitySchema>;

export const BriefRecoveryActionSchema = z.enum([
  'retry',
  'edit',
  'reject',
  'approve',
  'status',
  'resolve-unresolved',
  'revise',
]);
export type BriefRecoveryAction = z.infer<typeof BriefRecoveryActionSchema>;

export const EvidenceRefSchema = z
  .object({
    revision: nonNegativeInteger,
    hash,
    path,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const BriefRecoveryOriginSchema = z
  .object({
    mode: z.enum(['standard', 'speckit', 'instant', 'quick']),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan', 'auto-split']),
  })
  .strict();
export type BriefRecoveryOrigin = z.infer<typeof BriefRecoveryOriginSchema>;

const approvalContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('approval'),
    mode: z.enum(['standard', 'speckit']),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan', 'auto-split']),
  })
  .strict();
const speckitAnalysisContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('speckit-analysis'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();
const instantContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('instant-start'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();
const quickContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('quick-start'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();

export const BriefContinuationV1Schema = z.discriminatedUnion('kind', [
  approvalContinuationSchema,
  speckitAnalysisContinuationSchema,
  instantContinuationSchema,
  quickContinuationSchema,
]);
export type BriefContinuationV1 = z.infer<typeof BriefContinuationV1Schema>;

const BriefQualitySeveritySchema = z.enum(['error', 'warning']);

export const BriefQualityIssueSchema = z
  .object({
    code: id,
    severity: BriefQualitySeveritySchema,
    taskId: id.nullable(),
    message,
  })
  .strict();
export type BriefQualityIssue = z.infer<typeof BriefQualityIssueSchema>;

export const BriefQualityReportEvidenceSchema = z
  .object({
    briefHash: hash,
    report: EvidenceRefSchema,
    ruleVersion: id,
    issues: z.array(BriefQualityIssueSchema).max(MAX_ISSUES).readonly(),
    errorCount: nonNegativeInteger,
  })
  .superRefine((value, ctx) => {
    const actual = value.issues.filter((issue) => issue.severity === 'error').length;
    if (value.errorCount !== actual) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCount'],
        message: 'errorCount must equal the number of error issues',
      });
    }
  })
  .strict();
export type BriefQualityReportEvidence = z.infer<typeof BriefQualityReportEvidenceSchema>;
