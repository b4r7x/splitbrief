import { z } from 'zod';
import { GenerationCommonFields, createRunnerConfigSchema } from './runner-fields.js';

export const PlannerConfigSchema = createRunnerConfigSchema({ ...GenerationCommonFields, model: z.string().min(1).optional() });

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
export type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;

