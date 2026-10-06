import { z } from 'zod';
import { TaskIdSchema } from './task.js';
import { narrowRecord } from '../../utils/type-guards.js';

export const DriftSeveritySchema = z.enum(['info', 'warning', 'error']);

export const DriftCodeSchema = z.enum([
  'out_of_scope_file',
  'missing_expected_file',
  'orphan_diff',
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

/** Findings as saved; an older run's retired `out_of_bounds_text_match` finding is dropped on read. */
export const DriftFindingsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((finding) => narrowRecord(finding)?.code !== 'out_of_bounds_text_match')
      : value,
  z.array(DriftFindingSchema),
);

export const DriftReportSchema = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  findings: DriftFindingsSchema,
  briefHash: z.string().nullable().default(null),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;
