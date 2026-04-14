import { z } from 'zod';
import { GenerationCommonFields, createRunnerConfigSchema } from './runner-fields.js';

const PlannerCommonFields = {
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),
};

export const PlannerConfigSchema = createRunnerConfigSchema(PlannerCommonFields);

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

// Per-variant narrowing types for factory functions
export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
export type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;

