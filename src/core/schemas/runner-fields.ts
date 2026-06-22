import { z } from 'zod';
import { CliToolIdSchema, EffortLevelSchema, OutputFormatSchema } from './enums.js';
import type { CliToolId, RunnerKind } from './enums.js';

const PROMPT_PLACEHOLDER = '{prompt}';

const CommandFieldSchema = z
  .string()
  .min(1)
  .refine((command) => !command.includes(PROMPT_PLACEHOLDER), {
    message: 'command must not contain {prompt}; pass the prompt through stdin or args instead',
  });

const PlannerCapabilitiesSchema = z.strictObject({
  supportsConversationalPlanning: z.boolean(),
  supportsHintEscalation: z.boolean(),
  supportsSessionResume: z.boolean(),
  supportsEffort: z.boolean(),
  supportsImages: z.boolean(),
  supportsSelfSummarisation: z.boolean(),
});

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

const PlannerCapabilitiesField = {
  capabilities: PlannerCapabilitiesSchema.partial().optional(),
};

const ShellRunnerFields = {
  kind: z.literal('shell'),
  command: CommandFieldSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
};

const AgentRunnerFields = {
  kind: z.literal('agent'),
  command: CommandFieldSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
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
  trust: RunnerRoleTrustMetadata;
};

export type RunnerTrustMetadata = {
  executesLocalCommand: boolean;
  mayUseNetwork: boolean;
  mayWriteFilesDirectly: boolean;
  autoAllowFlags: readonly string[];
};

export type RunnerRole = 'planner' | 'implementer';

export type RunnerRoleTrustMetadata = Record<RunnerRole, RunnerTrustMetadata>;

type RunnerTrustConfig = { kind: 'cli'; tool: CliToolId } | { kind: Exclude<RunnerKind, 'cli'> };

const API_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: false,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: [],
};

const CLI_PLANNER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: [],
};

const CLI_IMPLEMENTER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: [],
};

const COMMAND_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: [],
};

const AGENT_SDK_PLANNER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: false,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: [],
};

const AGENT_SDK_IMPLEMENTER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: [],
};

const cliToolTrust = (implementerAutoAllowFlags: readonly string[]): RunnerRoleTrustMetadata => ({
  planner: CLI_PLANNER_TRUST,
  implementer: {
    ...CLI_IMPLEMENTER_TRUST,
    autoAllowFlags: implementerAutoAllowFlags,
  },
});

export const CLI_TOOL_TRUST = {
  'claude-code': cliToolTrust(['--permission-mode acceptEdits']),
  codex: cliToolTrust(['--sandbox workspace-write']),
  opencode: cliToolTrust([]),
  aider: cliToolTrust(['--yes-always']),
  copilot: cliToolTrust(['--allow-all']),
  'kilo-code': cliToolTrust(['--auto']),
} as const satisfies Record<CliToolId, RunnerRoleTrustMetadata>;

export const RUNNER_DESCRIPTORS = {
  cli: {
    fields: CliRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: false,
    trust: {
      planner: CLI_PLANNER_TRUST,
      implementer: CLI_IMPLEMENTER_TRUST,
    },
  },
  api: {
    fields: ApiRunnerFields,
    usesArgsOutputFormat: false,
    usesApiKey: true,
    requiresCommand: false,
    trust: {
      planner: API_TRUST,
      implementer: API_TRUST,
    },
  },
  shell: {
    fields: ShellRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: true,
    trust: {
      planner: COMMAND_TRUST,
      implementer: COMMAND_TRUST,
    },
  },
  agent: {
    fields: AgentRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: true,
    trust: {
      planner: COMMAND_TRUST,
      implementer: COMMAND_TRUST,
    },
  },
  'agent-sdk': {
    fields: AgentSdkRunnerFields,
    usesArgsOutputFormat: false,
    usesApiKey: true,
    requiresCommand: false,
    trust: {
      planner: AGENT_SDK_PLANNER_TRUST,
      implementer: AGENT_SDK_IMPLEMENTER_TRUST,
    },
  },
} as const satisfies Record<
  RunnerKind,
  { fields: Record<string, z.ZodTypeAny> } & RunnerKindCapabilities
>;

export function getRunnerKindMeta(kind: RunnerKind): RunnerKindCapabilities {
  return RUNNER_DESCRIPTORS[kind];
}

export function getRunnerTrustMeta(
  role: RunnerRole,
  runner: RunnerTrustConfig,
): RunnerTrustMetadata {
  if (runner.kind === 'cli') return CLI_TOOL_TRUST[runner.tool][role];
  return RUNNER_DESCRIPTORS[runner.kind].trust[role];
}

export function createRunnerConfigSchema<C extends z.ZodRawShape>(commonFields: C) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...RUNNER_DESCRIPTORS.cli.fields, ...commonFields }),
    z.strictObject({ ...RUNNER_DESCRIPTORS.api.fields, ...commonFields }),
    z.strictObject({ ...RUNNER_DESCRIPTORS.shell.fields, ...commonFields }),
    z.strictObject({ ...RUNNER_DESCRIPTORS.agent.fields, ...commonFields }),
    z.strictObject({ ...RUNNER_DESCRIPTORS['agent-sdk'].fields, ...commonFields }),
  ]);
}

export function createPlannerConfigSchema<C extends z.ZodRawShape>(commonFields: C) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...RUNNER_DESCRIPTORS.cli.fields, ...commonFields }),
    z.strictObject({ ...RUNNER_DESCRIPTORS.api.fields, ...commonFields }),
    z.strictObject({
      ...RUNNER_DESCRIPTORS.shell.fields,
      ...PlannerCapabilitiesField,
      ...commonFields,
    }),
    z.strictObject({
      ...RUNNER_DESCRIPTORS.agent.fields,
      ...PlannerCapabilitiesField,
      ...commonFields,
    }),
    z.strictObject({ ...RUNNER_DESCRIPTORS['agent-sdk'].fields, ...commonFields }),
  ]);
}
