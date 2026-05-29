import { z } from 'zod';
import { TaskIdSchema } from './task.js';

export const DriftSeveritySchema = z.enum(['info', 'warning', 'error']);

export const DriftCodeSchema = z.enum([
  'out_of_scope_file',
  'missing_expected_file',
  'orphan_diff',
  'out_of_bounds_text_match',
  'missing_evidence',
  'failed_task_with_diff',
]);

export const DriftFindingSchema = z.object({
  severity: DriftSeveritySchema,
  code: DriftCodeSchema,
  taskId: TaskIdSchema.optional(),
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
  briefHash: z.string().nullable().default(null),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

export function isDriftReport(value: unknown): value is DriftReport {
  return DriftReportSchema.safeParse(value).success;
}
