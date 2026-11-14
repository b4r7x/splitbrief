import { z } from 'zod';
import { CandidateIdSchema, RunnerRoleSchema } from './contract.js';
import { MAX_EVIDENCE_OUTPUT_BYTES } from './evidence.js';

/**
 * The factory harness's observed role/effect receipt that candidate admission
 * requires (REQ-014, REQ-017, REQ-048, REQ-049): the explicit role vector, the
 * terminal verdict, and the real staged-project effect. It records no secret
 * values; reasons are harness-sanitized and byte-bounded.
 */
export const CandidateEffectReceipt = z.strictObject({
  candidateId: CandidateIdSchema,
  role: RunnerRoleSchema,
  verdict: z.enum(['PASS', 'OMIT']),
  exitCode: z.number().int(),
  reason: z
    .string()
    .max(MAX_EVIDENCE_OUTPUT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES, {
      message: 'reason exceeds the evidence byte budget',
    })
    .optional(),
  changedFiles: z.array(z.string().min(1)).max(64).readonly(),
});
export type CandidateEffectReceipt = z.infer<typeof CandidateEffectReceipt>;

export type CandidateEffectRole = z.infer<typeof RunnerRoleSchema>;

export type CandidateEffectAdmission = Readonly<
  { admitted: true; receipt: CandidateEffectReceipt } | { admitted: false; reason: string }
>;

/**
 * Candidate admission requires the harness's observed role/effect receipt: a
 * PASS terminal outcome for the requested role whose real staged effect matches
 * that role. Terminal status outranks valid-looking bytes (REQ-014); an OMIT
 * receipt cannot admit even with plausible changed files. A planner admits only
 * with zero staged changes; a direct-write implementer admits only when the
 * receipt shows exactly the declared staged file (REQ-048). Admission never
 * writes canonical output (REQ-022).
 */
export function admitCandidateEffect(input: {
  receipt: unknown;
  role: CandidateEffectRole;
  declaredFile?: string | undefined;
}): CandidateEffectAdmission {
  const parsed = CandidateEffectReceipt.safeParse(input.receipt);
  if (!parsed.success) {
    return { admitted: false, reason: 'harness effect receipt is missing or invalid' };
  }
  const receipt = parsed.data;
  if (receipt.role !== input.role) {
    return { admitted: false, reason: `receipt role ${receipt.role} does not match ${input.role}` };
  }
  if (receipt.verdict !== 'PASS' || receipt.exitCode !== 0) {
    return {
      admitted: false,
      reason: `receipt terminal status ${receipt.verdict} (exit ${receipt.exitCode}) cannot admit`,
    };
  }
  if (input.role === 'planner') {
    if (receipt.changedFiles.length > 0) {
      return {
        admitted: false,
        reason: `planner receipt observed staged changes: ${receipt.changedFiles.join(', ')}`,
      };
    }
    return { admitted: true, receipt };
  }
  if (input.declaredFile === undefined || input.declaredFile.length === 0) {
    return { admitted: false, reason: 'implementer admission requires the declared staged file' };
  }
  if (receipt.changedFiles.length !== 1 || receipt.changedFiles[0] !== input.declaredFile) {
    const observed =
      receipt.changedFiles.length === 0 ? 'nothing' : receipt.changedFiles.join(', ');
    return {
      admitted: false,
      reason: `implementer receipt changed ${observed} instead of exactly ${input.declaredFile}`,
    };
  }
  return { admitted: true, receipt };
}
