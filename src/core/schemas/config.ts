import { z } from 'zod';
import { WorkflowModeSchema, CommitStrategySchema, ThemeModeSchema, ShikiThemeSchema } from './enums.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ImplementerConfigSchema } from './implementer-config.js';

export const EscalationConfigSchema = z.object({
  intermediateProvider: z.string().optional(),
  intermediateModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(2),
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
    maxBudget: z.number().positive().optional(),
    persistTranscript: z.boolean().default(true),
  }),
  theme: ThemeModeSchema.optional(),
  shikiTheme: ShikiThemeSchema.optional(),
  sessions: z.object({
    scope: z.enum(['project', 'global']).optional(),
  }).optional(),
  escalation: EscalationConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WORKFLOW_MODE = 'standard' as const;
