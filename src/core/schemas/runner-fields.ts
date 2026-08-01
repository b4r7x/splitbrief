import { z } from 'zod';
import { API_OFFERINGS, API_PROVIDER_CATALOG } from '../providers/api-provider-catalog.js';
import {
  CLI_AUTH_CHANNEL_IDS,
  CLI_TOOL_CATALOG,
  CLI_TOOL_TRUST,
  cliModelPolicyViolations,
  type CliModelPolicy,
  type RunnerRole,
  type RunnerRoleTrustMetadata,
  type RunnerTrustMetadata,
} from '../runners/cli-tool-catalog.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { isAutomaticModel, normalizeConfiguredModel } from '../providers/automatic-model.js';
import { hasAutomaticModelDefault } from '../providers/model-selection.js';
import {
  CliToolIdSchema,
  EffortLevelSchema,
  ImplementerApiProviderIdSchema,
  ImplementerCliToolIdSchema,
  OutputFormatSchema,
  PlannerApiProviderIdSchema,
  PlannerCliToolIdSchema,
} from './enums.js';
import type { CliToolId } from '../runners/cli-tool-catalog.js';
import type { RunnerKind } from './enums.js';

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

export const RUNNER_IDLE_WARN_MS = 300_000;
export const RUNNER_IDLE_KILL_MS = 1_800_000;
export const DEFAULT_IMPLEMENTER_TEMPERATURE = 0.3;

const WatchdogFields = {
  idleWarnMs: z.number().int().positive().max(3_600_000).optional(),
  idleKillMs: z.number().int().positive().max(3_600_000).optional(),
};

// The kill threshold must not fire before the warn threshold, or the runner is
// silently killed without ever warning. Unset fields take the runtime defaults
// above, so the mixed cases are validated too: a lone idleKillMs below the
// default warn (killed before the default warn timer fires) and a lone
// idleWarnMs above the default kill are both rejected.
function idleThresholdsOrdered(runner: Record<string, unknown>): boolean {
  const { idleWarnMs, idleKillMs } = runner;
  const warn = typeof idleWarnMs === 'number' ? idleWarnMs : RUNNER_IDLE_WARN_MS;
  const kill = typeof idleKillMs === 'number' ? idleKillMs : RUNNER_IDLE_KILL_MS;
  return kill >= warn;
}

const IDLE_THRESHOLD_ORDER = {
  message: `idleKillMs must be at least idleWarnMs (the warning fires before the kill); an unset field takes its default (${RUNNER_IDLE_WARN_MS} warn / ${RUNNER_IDLE_KILL_MS} kill)`,
  path: ['idleKillMs'],
};

const CliRunnerFields = {
  kind: z.literal('cli'),
  tool: CliToolIdSchema,
  authChannel: z.enum(CLI_AUTH_CHANNEL_IDS).optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  ...WatchdogFields,
};

const PlannerCliRunnerFields = {
  ...CliRunnerFields,
  tool: PlannerCliToolIdSchema,
};

const ImplementerCliRunnerFields = {
  ...CliRunnerFields,
  tool: ImplementerCliToolIdSchema,
};

const ApiOfferingSchema = z.enum(API_OFFERINGS);

const ApiRunnerFields = {
  kind: z.literal('api'),
  provider: z.string().min(1),
  service: z.string().min(1),
  offering: ApiOfferingSchema,
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
};

const API_PROVIDER_DESCRIPTORS = Object.values(API_PROVIDER_CATALOG);

function descriptorsForProviderIdentity(provider: string) {
  return API_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => descriptor.id === provider || descriptor.service === provider,
  );
}

function apiProviderSchemaForRole(role: RunnerRole) {
  const roleProviderIds =
    role === 'planner' ? PlannerApiProviderIdSchema : ImplementerApiProviderIdSchema;

  // Custom providers remain supported, but a string that names a catalog
  // identity — by descriptor id or by service — can never bypass its role
  // admission by taking the custom-provider branch.
  const customProvider = z
    .string()
    .min(1)
    .refine(
      (provider) => {
        const [descriptor] = descriptorsForProviderIdentity(provider);
        return (
          descriptor === undefined ||
          descriptor.roles.some((candidateRole) => candidateRole === role)
        );
      },
      {
        message: `API provider is not admitted for the ${role} role`,
      },
    );

  return z.union([roleProviderIds, customProvider]);
}

const PlannerApiRunnerFields = {
  ...ApiRunnerFields,
  provider: apiProviderSchemaForRole('planner'),
};

const ImplementerApiRunnerFields = {
  ...ApiRunnerFields,
  provider: apiProviderSchemaForRole('implementer'),
};

function validateAutomaticModelResolvable(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (!runner) return;

  const model = typeof runner.model === 'string' ? runner.model : undefined;
  if (model !== undefined && normalizeConfiguredModel(model) === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'model must be a model ID or "auto"',
    });
    return;
  }

  if (runner.kind !== 'api' || typeof runner.provider !== 'string') return;
  const automatic = runner.model === undefined || isAutomaticModel(model);
  if (!automatic || hasAutomaticModelDefault(runner.provider)) return;

  const spelling = runner.model === undefined ? 'an omitted model' : 'model "auto"';
  ctx.addIssue({
    code: 'custom',
    path: ['model'],
    message: `${spelling} cannot be resolved for API provider "${runner.provider}" — it has no catalog default; set an explicit model ID`,
  });
}

function validateApiIdentity(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (
    !runner ||
    runner.kind !== 'api' ||
    typeof runner.provider !== 'string' ||
    typeof runner.service !== 'string' ||
    typeof runner.offering !== 'string'
  ) {
    return;
  }

  const providerCandidates = descriptorsForProviderIdentity(runner.provider);
  if (
    providerCandidates.length > 0 &&
    !providerCandidates.some(
      (candidate) => candidate.service === runner.service && candidate.offering === runner.offering,
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['offering'],
      message: `API provider "${runner.provider}" does not match service "${runner.service}" with offering "${runner.offering}"`,
    });
    return;
  }

  const serviceCandidates = API_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => descriptor.service === runner.service,
  );
  if (
    serviceCandidates.length > 0 &&
    !serviceCandidates.some((candidate) => candidate.offering === runner.offering)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['offering'],
      message: `API service "${runner.service}" does not provide offering "${runner.offering}"`,
    });
  }
}

function validateCliModelPolicy(role: RunnerRole, input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (!runner || runner.kind !== 'cli' || typeof runner.tool !== 'string') return;

  const descriptor = Object.values(CLI_TOOL_CATALOG).find(({ id }) => id === runner.tool);
  if (descriptor === undefined) return;

  const selection = {
    model: typeof runner.model === 'string' ? runner.model : undefined,
    customModels: Array.isArray(runner.customModels)
      ? runner.customModels.filter((model): model is string => typeof model === 'string')
      : undefined,
  };
  for (const violation of cliModelPolicyViolations(descriptor.modelPolicy[role], selection)) {
    ctx.addIssue({
      code: 'custom',
      path: [violation.field],
      message: violation.message,
    });
  }
}

function validateCliAuthChannel(input: unknown, ctx: z.RefinementCtx): void {
  const runner = narrowRecord(input);
  if (
    !runner ||
    runner.kind !== 'cli' ||
    typeof runner.tool !== 'string' ||
    typeof runner.authChannel !== 'string'
  ) {
    return;
  }

  const descriptor = Object.values(CLI_TOOL_CATALOG).find(({ id }) => id === runner.tool);
  if (descriptor?.auth.channels.some(({ id }) => id === runner.authChannel)) return;
  ctx.addIssue({
    code: 'custom',
    path: ['authChannel'],
    message: `CLI tool "${runner.tool}" does not support auth channel "${runner.authChannel}"`,
  });
}

export function createCliModelPolicySchema(policy: CliModelPolicy) {
  return z
    .strictObject({
      model: z.string().min(1).optional(),
      customModels: z.array(z.string()).optional(),
    })
    .superRefine((selection, ctx) => {
      for (const violation of cliModelPolicyViolations(policy, selection)) {
        ctx.addIssue({
          code: 'custom',
          path: [violation.field],
          message: violation.message,
        });
      }
    });
}

const PlannerCapabilitiesField = {
  capabilities: PlannerCapabilitiesSchema.partial().optional(),
};

const ShellRunnerFields = {
  kind: z.literal('shell'),
  command: CommandFieldSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  ...WatchdogFields,
};

const AgentRunnerFields = {
  kind: z.literal('agent'),
  command: CommandFieldSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  ...WatchdogFields,
};

const AgentSdkRunnerFields = {
  kind: z.literal('agent-sdk'),
  apiKey: z.string().optional(),
  ...WatchdogFields,
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
  // Non-CLI kinds expose one role map. CLI trust is keyed by the catalog tool
  // because permission flags and posture are tool-specific.
  trust: RunnerRoleTrustMetadata | typeof CLI_TOOL_TRUST;
};

type RunnerTrustConfig = { kind: 'cli'; tool: CliToolId } | { kind: Exclude<RunnerKind, 'cli'> };

const API_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: false,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
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

export const RUNNER_DESCRIPTORS = {
  cli: {
    fields: CliRunnerFields,
    usesArgsOutputFormat: true,
    usesApiKey: false,
    requiresCommand: false,
    trust: CLI_TOOL_TRUST,
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
  const { model: _requiredModel, ...cliCommonFields } = commonFields;
  return z
    .discriminatedUnion('kind', [
      z.strictObject({
        ...cliCommonFields,
        ...ImplementerCliRunnerFields,
        model: z.string().min(1).optional(),
      }),
      z.strictObject({ ...commonFields, ...ImplementerApiRunnerFields }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS.shell.fields }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS.agent.fields }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS['agent-sdk'].fields }),
    ])
    .superRefine((input, ctx) => {
      validateApiIdentity(input, ctx);
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('implementer', input, ctx);
      validateCliAuthChannel(input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
}

export function createPlannerConfigSchema<C extends z.ZodRawShape>(commonFields: C) {
  const { model: _configuredModel, ...cliCommonFields } = commonFields;
  return z
    .discriminatedUnion('kind', [
      z.strictObject({
        ...cliCommonFields,
        ...PlannerCliRunnerFields,
        model: z.string().min(1).optional(),
      }),
      z.strictObject({ ...commonFields, ...PlannerApiRunnerFields }),
      z.strictObject({
        ...commonFields,
        ...RUNNER_DESCRIPTORS.shell.fields,
        ...PlannerCapabilitiesField,
      }),
      z.strictObject({
        ...commonFields,
        ...RUNNER_DESCRIPTORS.agent.fields,
        ...PlannerCapabilitiesField,
      }),
      z.strictObject({ ...commonFields, ...RUNNER_DESCRIPTORS['agent-sdk'].fields }),
    ])
    .superRefine((input, ctx) => {
      validateApiIdentity(input, ctx);
      validateAutomaticModelResolvable(input, ctx);
      validateCliModelPolicy('planner', input, ctx);
      validateCliAuthChannel(input, ctx);
    })
    .refine(idleThresholdsOrdered, IDLE_THRESHOLD_ORDER);
}
