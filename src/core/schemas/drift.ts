import { z } from 'zod';

export const DriftSeveritySchema = z.enum(['info', 'warning', 'error']);
export type DriftSeverity = z.infer<typeof DriftSeveritySchema>;

export const DriftCodeSchema = z.enum([
  'out_of_scope_file',
  'missing_expected_file',
  'orphan_diff',
  'out_of_bounds_text_match',
  'missing_evidence',
  'failed_task_with_diff',
]);
export type DriftCode = z.infer<typeof DriftCodeSchema>;

export const DriftFindingSchema = z.object({
  severity: DriftSeveritySchema,
  code: DriftCodeSchema,
  taskId: z.string().optional(),
  file: z.string().optional(),
  message: z.string(),
});
export type DriftFinding = z.infer<typeof DriftFindingSchema>;

export const DriftReportSchema = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  score: z.number().refine(Number.isFinite, { message: 'score must be finite' }),
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  findings: z.array(DriftFindingSchema),
  briefHash: z.string().nullable(),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

export function isDriftReport(value: unknown): value is DriftReport {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1
    && typeof v.passed === 'boolean'
    && typeof v.score === 'number'
    && Number.isFinite(v.score)
    && Array.isArray(v.changedFiles)
    && Array.isArray(v.expectedFiles)
    && Array.isArray(v.findings);
}
