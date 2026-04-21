import { z } from 'zod';
import { WorkflowModeSchema, CommitStrategySchema, ApproveLevelSchema, ThemeModeSchema, ShikiThemeSchema } from './enums.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ImplementerConfigSchema } from './implementer-config.js';
import { CodebaseConfigSchema } from './codebase.js';
import { HooksConfigSchema } from './hooks.js';
import { OtelConfigSchema } from './otel.js';

export const EscalationConfigSchema = z.object({
  intermediateProvider: z.string().optional(),
  intermediateModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const GitWorkflowConfigSchema = z.object({
  commitStrategy: CommitStrategySchema.optional(),
  createBranch: z.boolean().optional(),
});

export const SpeckitWorkflowConfigSchema = z.object({
  minCoverage: z.number().min(0).max(1).optional(),
});

/**
 * v3 ConfigSchema. Accepts both `version: 2` and `version: 3` on input for
 * backward compatibility (see migration.md §2.3). Deprecated v2 fields
 * (`autoApproveSpec`, `autoApprovePlan`, top-level `commitStrategy`) remain
 * optional alongside their v3 replacements (`approve`, `git.commitStrategy`)
 * until briefs 04 and 07 retire the read sites.
 */
export const ConfigSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  validation: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    testCommand: z.string().min(1),
  }),
  workflow: z.object({
    autoApproveSpec: z.boolean().optional(),
    autoApprovePlan: z.boolean().optional(),
    approve: ApproveLevelSchema.optional(),
    maxRetries: z.number().int().min(0),
    commitStrategy: CommitStrategySchema.optional(),
    git: GitWorkflowConfigSchema.optional(),
    speckit: SpeckitWorkflowConfigSchema.optional(),
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
  codebase: CodebaseConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  otel: OtelConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_WORKFLOW_MODE = 'standard' as const;
