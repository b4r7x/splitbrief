import { z } from 'zod';
import { CliToolIdSchema, OutputFormatSchema } from './enums.js';

export const CliRunnerFields = {
  kind: z.literal('cli'),
  tool: CliToolIdSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
};

export const ApiRunnerFields = {
  kind: z.literal('api'),
  provider: z.string().min(1),
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
};

export const ShellRunnerFields = {
  kind: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
};

export const AgentRunnerFields = {
  kind: z.literal('agent'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
};

export const AgentSdkRunnerFields = {
  kind: z.literal('agent-sdk'),
  apiKey: z.string().optional(),
};

export const GenerationCommonFields = {
  model: z.string().min(1),
  customModels: z.array(z.string()).optional(),
  contextLength: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().positive().max(600000).optional(),
};
