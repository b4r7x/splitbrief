import { z } from 'zod';
import { includes } from '../../../utils/type-guards.js';
import { API_OFFERINGS, API_PROVIDER_CATALOG } from '../../providers/api-catalog.js';
import { isListedCliTool, CLI_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import { type ActiveRunnerRole, runnerRoleForActiveRole } from '../../runners/seat-roles.js';
import {
  CliToolIdSchema,
  OutputFormatSchema,
  PlannerApiProviderIdSchema,
  ImplementerApiProviderIdSchema,
  EffortLevelSchema,
  type RunnerKind,
} from '../enums.js';

const PROMPT_PLACEHOLDER = '{prompt}';
export const PROMPT_PLACEHOLDER_NOT_SUPPORTED =
  '{prompt} is not supported; SPLITBRIEF sends the prompt on stdin';

export function hasPromptPlaceholder(value: string): boolean {
  return value.includes(PROMPT_PLACEHOLDER);
}

export const REMOVED_API_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'deepseek',
  'groq',
  'ollama-cloud',
  'openai',
  'openrouter',
  'together',
] as const);

export const REMOVED_CLI_TOOL_IDS = Object.freeze(['aider'] as const);

export const REMOVED_RUNNER_KINDS = Object.freeze(['agent-sdk'] as const);

// The tool enums reject a removed id before any refinement runs, so the named
// message has to come from a guard that sits in front of them. The supported
// list is the caller's catalog slice, so it cannot drift from the enum it pipes into;
// it names only the listed tools.
export function removedCliToolGuard(supportedToolIds: readonly string[]) {
  return z.string().superRefine((tool, ctx) => {
    if (!includes(REMOVED_CLI_TOOL_IDS, tool)) return;
    ctx.addIssue({
      code: 'custom',
      message: `CLI tool "${tool}" was removed; supported tools are ${supportedToolIds.filter(isListedCliTool).join(', ')}.`,
    });
  });
}

export const EnvironmentReferenceNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'Use an uppercase environment variable name');

const noPromptPlaceholder = [
  (value: string) => !hasPromptPlaceholder(value),
  { message: PROMPT_PLACEHOLDER_NOT_SUPPORTED },
] as const;

const CommandFieldSchema = z
  .string()
  .min(1)
  .refine(...noPromptPlaceholder);

const CommandArgsSchema = z.array(z.string().refine(...noPromptPlaceholder));

export const RUNNER_IDLE_WARN_MS = 300_000;
export const DEFAULT_IMPLEMENTER_TEMPERATURE = 0.3;

const WatchdogFields = {
  idleWarnMs: z.number().int().positive().optional(),
  idleKillMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
};

// A set kill threshold must not fire before the warn threshold, or the runner
// is silently killed without ever warning. An unset idleWarnMs takes the
// default warn, so a lone idleKillMs below it is rejected. An unset idleKillMs
// means no kill, so a lone idleWarnMs of any size is valid.
export function idleThresholdsOrdered(runner: Record<string, unknown>): boolean {
  const { idleWarnMs, idleKillMs } = runner;
  if (typeof idleKillMs !== 'number') return true;
  const warn = typeof idleWarnMs === 'number' ? idleWarnMs : RUNNER_IDLE_WARN_MS;
  return idleKillMs >= warn;
}

export const IDLE_THRESHOLD_ORDER = {
  message: `idleKillMs must be at least idleWarnMs (the warning fires before the kill); an unset idleWarnMs takes its default (${RUNNER_IDLE_WARN_MS})`,
  path: ['idleKillMs'],
};

export const CliRunnerFields = {
  kind: z.literal('cli'),
  tool: removedCliToolGuard(CLI_TOOL_IDS).pipe(CliToolIdSchema),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  ...WatchdogFields,
};

const ApiOfferingSchema = z.enum(API_OFFERINGS);

export const ApiRunnerFields = {
  kind: z.literal('api'),
  provider: z.string().min(1),
  service: z.string().min(1),
  offering: ApiOfferingSchema,
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
};

export const API_PROVIDER_DESCRIPTORS = Object.values(API_PROVIDER_CATALOG);

export function descriptorsForProviderIdentity(provider: string) {
  return API_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => descriptor.id === provider || descriptor.service === provider,
  );
}

// The seat label only names the config block the reader is editing; admission follows its role.
export function apiProviderSchemaForSeat(seat: ActiveRunnerRole) {
  const role = runnerRoleForActiveRole(seat);
  const roleProviderIds =
    role === 'planner' ? PlannerApiProviderIdSchema : ImplementerApiProviderIdSchema;

  // Custom providers remain supported, but a string that names a catalog
  // identity — by descriptor id or by service — can never bypass its role
  // admission by taking the custom-provider branch.
  const customProvider = z
    .string()
    .min(1)
    .refine(
      (provider) =>
        descriptorsForProviderIdentity(provider).every((descriptor) =>
          descriptor.roles.some((candidateRole) => candidateRole === role),
        ),
      {
        message: `API provider is not admitted for the ${seat} role`,
      },
    );

  return z.union([roleProviderIds, customProvider]);
}

const ShellRunnerFields = {
  kind: z.literal('shell'),
  command: CommandFieldSchema,
  args: CommandArgsSchema.optional(),
  outputFormat: OutputFormatSchema.optional(),
  env: z.array(EnvironmentReferenceNameSchema).optional(),
  ...WatchdogFields,
};

const AgentRunnerFields = {
  kind: z.literal('agent'),
  command: CommandFieldSchema,
  args: CommandArgsSchema.optional(),
  outputFormat: OutputFormatSchema.optional(),
  env: z.array(EnvironmentReferenceNameSchema).optional(),
  ...WatchdogFields,
};

export const GenerationCommonFields = {
  model: z.string().min(1),
  customModels: z.array(z.string()).optional(),
  contextLength: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().positive().optional(),
  effort: EffortLevelSchema.optional(),
  variant: z.string().min(1).optional(),
};

/**
 * The runner a seat moves to when it goes down: always a cli runner, always a
 * subset of the seat's own fields. It is validated as a runner by the seat it
 * is declared on, so it is not a runner block of its own.
 */
const FallbackRunnerFields = {
  tool: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: EffortLevelSchema.optional(),
  variant: z.string().min(1).optional(),
};

const FallbackRunnerSchema = z.strictObject(FallbackRunnerFields);

export const SeatFallbackField = {
  fallback: FallbackRunnerSchema.optional(),
};

export const RUNNER_DESCRIPTORS = {
  cli: { fields: CliRunnerFields },
  api: { fields: ApiRunnerFields },
  shell: { fields: ShellRunnerFields },
  agent: { fields: AgentRunnerFields },
} as const satisfies Record<RunnerKind, { fields: Record<string, z.ZodTypeAny> }>;
