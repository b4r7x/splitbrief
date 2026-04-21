import { z } from 'zod';

export const ConstitutionViolationSchema = z.object({
  principle: z.string(),
  reason: z.string(),
  severity: z.enum(['hard', 'soft']),
});
export type ConstitutionViolation = z.infer<typeof ConstitutionViolationSchema>;

export const ConstitutionCheckResultSchema = z.object({
  passed: z.boolean(),
  violations: z.array(ConstitutionViolationSchema),
});
export type ConstitutionCheckResult = z.infer<typeof ConstitutionCheckResultSchema>;
