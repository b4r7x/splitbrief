import { z } from 'zod';
import type { ApiRunnerRole } from '../../../core/providers/api-provider-catalog.js';
import { CandidateIdSchema, RunnerRoleSchema } from './contract.js';

export const MAX_EVIDENCE_OUTPUT_BYTES = 32_768;

export const CONFORMANCE_EXIT_CODES = Object.freeze({
  PASS: 0,
  HARNESS_FAILURE: 1,
  OMIT: 2,
} as const);

const TRUNCATION_MARKER = '…';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`,
  'g',
);
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|access[_-]?token|auth(?:entication)?|password|secret|token)[\s"'=:]+)([^\s,;"'}]+)/gi;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const ABSOLUTE_USER_PATH_PATTERN = /(?:\/(?:Users|home)\/[^\s]+|[A-Za-z]:[\\/]Users[\\/][^\s]+)/g;

export type CandidateEvidenceRole = ApiRunnerRole;

const ContractHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'contractSha256 must be lowercase SHA-256');
const CandidateEvidenceCaptureSchema = z.strictObject({
  candidateId: CandidateIdSchema,
  role: RunnerRoleSchema,
  contractSha256: ContractHashSchema,
  stdout: z
    .string()
    .max(MAX_EVIDENCE_OUTPUT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES, {
      message: 'stdout exceeds the evidence byte budget',
    })
    .refine((value) => !hasUnsanitizedCandidateOutput(value), {
      message: 'stdout must be sanitized before it is recorded',
    }),
  stderr: z
    .string()
    .max(MAX_EVIDENCE_OUTPUT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES, {
      message: 'stderr exceeds the evidence byte budget',
    })
    .refine((value) => !hasUnsanitizedCandidateOutput(value), {
      message: 'stderr must be sanitized before it is recorded',
    }),
});

function hasUnsanitizedCandidateOutput(value: string): boolean {
  return sanitizeCandidateOutput(value) !== value;
}

export const CandidateEvidence = z
  .strictObject({
    rawCapture: CandidateEvidenceCaptureSchema,
    productionConformance: CandidateEvidenceCaptureSchema.nullable(),
    verdict: z.enum(['PASS', 'OMIT']),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.verdict === 'PASS' && evidence.productionConformance === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['productionConformance'],
        message: 'PASS requires production conformance evidence',
      });
    }
    if (
      evidence.productionConformance !== null &&
      (evidence.productionConformance.candidateId !== evidence.rawCapture.candidateId ||
        evidence.productionConformance.role !== evidence.rawCapture.role ||
        evidence.productionConformance.contractSha256 !== evidence.rawCapture.contractSha256)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['productionConformance'],
        message: 'production evidence identity must match raw capture',
      });
    }
  });
export type CandidateEvidence = z.infer<typeof CandidateEvidence>;

function truncateToCharacterBoundary(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes.at(end) ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function sanitizeCandidateOutput(
  value: string,
  maxBytes = MAX_EVIDENCE_OUTPUT_BYTES,
): string {
  const redacted = value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(BEARER_PATTERN, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(ABSOLUTE_USER_PATH_PATTERN, '/[PATH]');
  if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted;
  return maxBytes <= TRUNCATION_MARKER_BYTES
    ? truncateToCharacterBoundary(redacted, maxBytes)
    : `${truncateToCharacterBoundary(redacted, maxBytes - TRUNCATION_MARKER_BYTES)}${TRUNCATION_MARKER}`;
}

export function createCandidateEvidenceCapture(input: {
  candidateId: string;
  role: CandidateEvidenceRole;
  contractSha256: string;
  stdout?: string;
  stderr?: string;
}): CandidateEvidence['rawCapture'] {
  return {
    candidateId: CandidateIdSchema.parse(input.candidateId),
    role: RunnerRoleSchema.parse(input.role),
    contractSha256: ContractHashSchema.parse(input.contractSha256),
    stdout: sanitizeCandidateOutput(input.stdout ?? ''),
    stderr: sanitizeCandidateOutput(input.stderr ?? ''),
  };
}

export function normalizeCandidateEvidence(input: {
  rawCapture: Parameters<typeof createCandidateEvidenceCapture>[0];
  productionConformance?: Parameters<typeof createCandidateEvidenceCapture>[0] | null;
  verdict: 'PASS' | 'OMIT';
}): CandidateEvidence {
  return CandidateEvidence.parse({
    rawCapture: createCandidateEvidenceCapture(input.rawCapture),
    productionConformance:
      input.productionConformance === undefined || input.productionConformance === null
        ? null
        : createCandidateEvidenceCapture(input.productionConformance),
    verdict: input.verdict,
  });
}
