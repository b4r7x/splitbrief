import { z } from 'zod';
import {
  GenerationCommonFields,
  commandKindCapabilityGuard,
  createPlannerConfigSchema,
} from './runner-fields.js';

export const PlannerConfigSchema = createPlannerConfigSchema({
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),
}).superRefine(commandKindCapabilityGuard('planner'));

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
export type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;
