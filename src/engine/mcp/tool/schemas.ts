import { z } from 'zod';
import { TaskIdSchema } from '../../../core/schemas/task.js';

export const ReportEvidenceInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  observedEvidence: z.array(z.string().min(1)).min(1),
  changedFiles: z.array(z.string()).optional(),
});

export const ReportProgressInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  message: z.string().min(1),
  percentComplete: z.number().min(0).max(100).optional(),
});

export const MarkTaskDoneInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  changedFiles: z.array(z.string()).min(1),
  observedEvidence: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

export const ReportValidationResultInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  stage: z.enum(['tsc', 'lint', 'test']),
  passed: z.boolean(),
  errorSummary: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
});

export const ReportErrorInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  error: z.string().min(1),
  changedFiles: z.array(z.string()).optional(),
  recoverable: z.boolean().optional(),
});
