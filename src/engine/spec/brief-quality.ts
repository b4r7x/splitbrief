import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';

const BRIEF_QUALITY_CODES = [
  'missing_scope',
  'missing_validation',
  'vague_validation',
  'missing_evidence',
  'missing_escalation',
  'missing_code_context',
  'empty_task_list',
  'write_outside_declared_files',
  'anchor_not_in_files',
  'test_without_code',
  'missing_type_definitions',
  'missing_implementation_steps',
] as const;

const briefQualityIssueSchema = z
  .object({
    code: z.enum(BRIEF_QUALITY_CODES),
    severity: z.enum(['error', 'warning']),
    taskId: TaskIdSchema,
    message: z.string().trim().min(1).max(4_096),
  })
  .strict();

const briefQualityReportSchema = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(briefQualityIssueSchema),
});

export type BriefQualityReport = z.infer<typeof briefQualityReportSchema>;

export function isBriefQualityReport(value: unknown): value is BriefQualityReport {
  return briefQualityReportSchema.safeParse(value).success;
}
