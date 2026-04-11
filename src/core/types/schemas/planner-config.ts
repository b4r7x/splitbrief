import { z } from 'zod';
import {
  CliRunnerFields,
  ApiRunnerFields,
  ShellRunnerFields,
  AgentRunnerFields,
  AgentSdkRunnerFields,
  GenerationCommonFields,
} from './runner-fields.js';

/**
 * Planner-specific common fields.
 * Unlike implementer, model is optional (some CLI planners auto-select).
 */
const PlannerCommonFields = {
  ...GenerationCommonFields,
  model: z.string().min(1).optional(), // Override to optional
};

/**
 * Planner config discriminated union.
 * 5 variants matching the 5 runner kinds.
 */
export const PlannerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields, ...PlannerCommonFields }).strict(),
  z.object({ ...ApiRunnerFields, ...PlannerCommonFields }).strict(),
  z.object({ ...ShellRunnerFields, ...PlannerCommonFields }).strict(),
  z.object({ ...AgentRunnerFields, ...PlannerCommonFields }).strict(),
  z.object({ ...AgentSdkRunnerFields, ...PlannerCommonFields }).strict(),
]);

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

// Per-variant narrowing types for factory functions
export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
export type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;

// Union of all planner runner kinds
export type PlannerRunnerKind = PlannerConfig['kind'];
