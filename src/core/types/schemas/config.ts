import { z } from 'zod';
import {
  WorkflowModeSchema, CommitStrategySchema, ThemeModeSchema, ShikiThemeSchema,
  OutputFormatSchema, ImplementerKindSchema,
  CliPlannerToolSchema, ProviderIdSchema,
} from './enums.js';

const CliPlannerSchema = z.object({
  kind: z.literal('cli'),
  tool: CliPlannerToolSchema,
  model: z.string().optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  customModels: z.array(z.string()).optional(),
});

const AgentSdkPlannerSchema = z.object({
  kind: z.literal('agent-sdk'),
  model: z.string().optional(),
  permissionMode: z.literal('acceptEdits').optional(),
  apiKey: z.string().optional(),
  customModels: z.array(z.string()).optional(),
});

const ApiPlannerSchema = z.object({
  kind: z.literal('api'),
  provider: ProviderIdSchema,
  model: z.string(),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
  customModels: z.array(z.string()).optional(),
});

const ShellPlannerSchema = z.object({
  kind: z.literal('shell'),
  command: z.string(),
  model: z.string().optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  customModels: z.array(z.string()).optional(),
});

export const PlannerConfigSchema = z.discriminatedUnion('kind', [
  CliPlannerSchema, AgentSdkPlannerSchema, ApiPlannerSchema, ShellPlannerSchema,
]);

export const ImplementerConfigSchema = z.object({
  kind: ImplementerKindSchema.default('api'),
  tool: z.string(),
  model: z.string().min(1),
  apiBase: z.string(),
  contextLength: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  apiKey: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  timeout: z.number().positive().max(600000).optional(),
  customModels: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  validation: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    testCommand: z.string().min(1),
  }),
  workflow: z.object({
    autoApproveSpec: z.boolean(),
    autoApprovePlan: z.boolean(),
    maxRetries: z.number().int().min(0),
    commitStrategy: CommitStrategySchema,
    mode: WorkflowModeSchema.optional(),
  }),
  theme: ThemeModeSchema.optional(),
  shikiTheme: ShikiThemeSchema.optional(),
  sessions: z.object({
    scope: z.enum(['project', 'global']).optional(),
  }).optional(),
});
