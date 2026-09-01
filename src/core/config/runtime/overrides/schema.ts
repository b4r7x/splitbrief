import { z } from 'zod';
import { OutputFormatSchema } from '../../../schemas/enums.js';

export const RunnerOverrideSchema = z.object({
  tool: z.string().optional(),
  model: z.string().optional(),
  command: z.string().optional(),
  apiBase: z.string().optional(),
  apiKey: z.string().optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  contextLength: z.number().optional(),
});

export const CLIOverridesSchema = z.object({
  planner: RunnerOverrideSchema.optional(),
  implementer: RunnerOverrideSchema.optional(),
  reviewer: RunnerOverrideSchema.optional(),
  approve: z.string().optional(),
  mode: z.string().optional(),
  budget: z.number().optional(),
  contextLength: z.number().optional(),
  plannerEffort: z.string().optional(),
  reviewerEffort: z.string().optional(),
  yolo: z.boolean().optional(),
});

export type CLIOverrides = z.infer<typeof CLIOverridesSchema>;

export type RunnerOverrides = z.infer<typeof RunnerOverrideSchema>;
