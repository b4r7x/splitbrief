import { z } from 'zod';
import { CliToolIdSchema, EffortLevelSchema, OutputFormatSchema } from './enums.js';
import type { RunnerKind } from './enums.js';

const PlannerCapabilitiesSchema = z
  .object({
    supportsConversationalPlanning: z.boolean(),
    supportsHintEscalation: z.boolean(),
    supportsSessionResume: z.boolean(),
    supportsEffort: z.boolean(),
    supportsImages: z.boolean(),
    supportsSelfSummarisation: z.boolean(),
  })
  .strict();

const CliRunnerFields = {
  kind: z.literal('cli'),
  tool: CliToolIdSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
};

const ApiRunnerFields = {
  kind: z.literal('api'),
  provider: z.string().min(1),
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
};

const ShellRunnerFields = {
  kind: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  capabilities: PlannerCapabilitiesSchema.partial().optional(),
};

const AgentRunnerFields = {
  kind: z.literal('agent'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  capabilities: PlannerCapabilitiesSchema.partial().optional(),
};

const AgentSdkRunnerFields = {
  kind: z.literal('agent-sdk'),
  apiKey: z.string().optional(),
};

export const GenerationCommonFields = {
  model: z.string().min(1),
  customModels: z.array(z.string()).optional(),
  contextLength: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().positive().max(600000).optional(),
  effort: EffortLevelSchema.optional(),
};

type RunnerKindCapabilities = {
  usesArgsOutputFormat: boolean;
  usesApiKey: boolean;
  requiresCommand: boolean;
};

export const RUNNER_DESCRIPTORS = {
  cli: {
    fields: CliRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: false,
  },
  api: {
    fields: ApiRunnerFields,
    usesArgsOutputFormat: false,
    usesApiKey: true,
    requiresCommand: false,
  },
  shell: {
    fields: ShellRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: true,
  },
  agent: {
    fields: AgentRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: true,
  },
  'agent-sdk': {
    fields: AgentSdkRunnerFields,
    usesArgsOutputFormat: false,
    usesApiKey: true,
    requiresCommand: false,
  },
} as const satisfies Record<
  RunnerKind,
  { fields: Record<string, z.ZodTypeAny> } & RunnerKindCapabilities
>;

export function getRunnerKindMeta(kind: RunnerKind): RunnerKindCapabilities {
  return RUNNER_DESCRIPTORS[kind];
}

export function createRunnerConfigSchema<C extends z.ZodRawShape>(commonFields: C) {
  return z.discriminatedUnion('kind', [
    z.object({ ...RUNNER_DESCRIPTORS.cli.fields, ...commonFields }).strict(),
    z.object({ ...RUNNER_DESCRIPTORS.api.fields, ...commonFields }).strict(),
    z.object({ ...RUNNER_DESCRIPTORS.shell.fields, ...commonFields }).strict(),
    z.object({ ...RUNNER_DESCRIPTORS.agent.fields, ...commonFields }).strict(),
    z.object({ ...RUNNER_DESCRIPTORS['agent-sdk'].fields, ...commonFields }).strict(),
  ]);
}
