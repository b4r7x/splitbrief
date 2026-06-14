import { z } from 'zod';
import { GenerationCommonFields, createPlannerConfigSchema } from './runner-fields.js';

export const PlannerConfigSchema = createPlannerConfigSchema({
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.kind !== 'shell' && cfg.kind !== 'agent') return;
  if (cfg.capabilities?.supportsEffort === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'supportsEffort'],
      message: `Runner kind "${cfg.kind}" has no channel to deliver an effort hint to the command; remove supportsEffort or use a cli/api/agent-sdk planner`,
    });
  }
  if (cfg.capabilities?.supportsImages === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'supportsImages'],
      message: `Runner kind "${cfg.kind}" has no channel to deliver image attachments to the command; remove supportsImages or use a cli/api/agent-sdk planner`,
    });
  }
});

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
export type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
export type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
export type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
export type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;
