import { z } from 'zod';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { ValidationStageSchema } from '../../../core/schemas/enums.js';
import { ProjectRelativeChangedFileSchema } from '../../../core/evidence/changed-file-path.js';
import { stripTerminalControls } from '../../../utils/display-text.js';

const EvidenceTextSchema = z
  .string()
  .min(1)
  .transform((text) => stripTerminalControls(text))
  .pipe(z.string().min(1));

const ChangedFilesSchema = z.array(ProjectRelativeChangedFileSchema);

export const ReportEvidenceInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  observedEvidence: z.array(EvidenceTextSchema).min(1),
  changedFiles: ChangedFilesSchema.optional(),
});

export const ReportProgressInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  message: EvidenceTextSchema,
  percentComplete: z.number().min(0).max(100).optional(),
});

export const MarkTaskDoneInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  changedFiles: ChangedFilesSchema.min(1),
  observedEvidence: z.array(EvidenceTextSchema).optional(),
  summary: EvidenceTextSchema.optional(),
});

export const ReportValidationResultInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  stage: ValidationStageSchema,
  passed: z.boolean(),
  errorSummary: EvidenceTextSchema.optional(),
  changedFiles: ChangedFilesSchema.optional(),
});

export const ReportErrorInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  error: EvidenceTextSchema,
  changedFiles: ChangedFilesSchema.optional(),
  recoverable: z.boolean().optional(),
});
