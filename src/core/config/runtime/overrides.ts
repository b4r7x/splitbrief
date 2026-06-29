import { z } from 'zod';
import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from './build-runner.js';
import {
  APPROVE_LEVELS,
  ApproveLevelSchema,
  EFFORT_LEVELS,
  EffortLevelSchema,
  OutputFormatSchema,
  WORKFLOW_MODES,
  WorkflowModeSchema,
  normalizeLegacyMode,
  type ApproveLevel,
  type EffortLevel,
} from '../../schemas/enums.js';
import { configError } from '../errors.js';
import { assertNever } from '../../../utils/type-guards.js';
import { warnStderr } from '../../../lib/warn.js';
import type { RunnerKind } from '../../schemas/enums.js';
import type { Config } from '../../schemas/config.js';
import { defaultApprovalConfig } from '../../schemas/config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { WorkflowOpts } from '../../types/config-options.js';
import type { WorkflowMode } from '../../schemas/enums.js';
import { getWorkflowMode } from '../accessors/values.js';
import {
  mergeImplementerProfileMetadata,
  pickDefaultProfileName,
  stripProfileMetadata,
} from '../accessors/implementer-profiles.js';

const RunnerOverrideSchema = z.object({
  tool: z.string().optional(),
  model: z.string().optional(),
  command: z.string().optional(),
  apiBase: z.string().optional(),
  apiKey: z.string().optional(),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
  contextLength: z.number().optional(),
});

export const CLIOverridesSchema = z.object({
  planner: RunnerOverrideSchema.optional(),
  implementer: RunnerOverrideSchema.optional(),
  autoApprove: z.boolean().optional(),
  approve: z.string().optional(),
  mode: z
    .preprocess(
      (m) => (typeof m === 'string' ? (normalizeLegacyMode(m) ?? m) : m),
      WorkflowModeSchema,
    )
    .optional(),
  budget: z.number().optional(),
  contextLength: z.number().optional(),
  plannerEffort: z.string().optional(),
  yolo: z.boolean().optional(),
});

export type CLIOverrides = z.infer<typeof CLIOverridesSchema>;

export function resolveCliWorkflowMode(opts: WorkflowOpts, config: Config): WorkflowMode {
  return opts.mode ?? getWorkflowMode(config);
}

export function workflowOptsToCLIOverrides(opts: WorkflowOpts): CLIOverrides {
  return {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
      apiBase: opts.plannerApiBase,
      apiKey: opts.plannerApiKeyEnv,
      args: opts.plannerArgs,
      outputFormat: opts.plannerOutputFormat,
      contextLength: opts.plannerContextLength,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
      apiBase: opts.implementerApiBase,
      apiKey: opts.implementerApiKeyEnv,
      args: opts.implementerArgs,
      outputFormat: opts.implementerOutputFormat,
      contextLength: opts.implementerContextLength,
    },
    autoApprove: opts.auto,
    approve: opts.approve,
    mode: opts.mode,
    budget: opts.budget,
    plannerEffort: opts.plannerEffort,
    yolo: opts.yolo,
  };
}

type RunnerOverrides = z.infer<typeof RunnerOverrideSchema>;

export function existingToOpts(existing: PlannerConfig | ImplementerConfig): BuildRunnerOpts {
  if (existing.kind === 'cli') {
    return {
      kind: 'cli',
      tool: existing.tool,
      ...('args' in existing && { args: existing.args }),
      ...('outputFormat' in existing && { outputFormat: existing.outputFormat }),
    };
  }
  if (existing.kind === 'api') {
    return {
      kind: 'api',
      tool: existing.provider,
      apiBase: existing.apiBase,
      ...('apiKey' in existing && { apiKey: existing.apiKey }),
    };
  }
  if (existing.kind === 'shell' || existing.kind === 'agent') {
    return {
      kind: existing.kind,
      command: existing.command,
      ...('args' in existing && { args: existing.args }),
      ...('outputFormat' in existing && { outputFormat: existing.outputFormat }),
    };
  }
  if (existing.kind === 'agent-sdk') {
    return { kind: 'agent-sdk', ...('apiKey' in existing && { apiKey: existing.apiKey }) };
  }
  return assertNever(existing);
}

export function applyRunnerOverrides(
  role: 'planner' | 'implementer',
  overrides: RunnerOverrides,
  config: Config,
): Config {
  if (role === 'planner') {
    const updated = buildRunnerFromOverrides('planner', overrides, config.planner);
    return updated === undefined ? config : { ...config, planner: updated };
  }

  const updated = buildRunnerFromOverrides('implementer', overrides, config.implementer);
  return updated === undefined ? config : { ...config, implementer: updated };
}

function warnUnusableProviderOverrides(
  role: 'planner' | 'implementer',
  kind: RunnerKind,
  apiBase: string | undefined,
  apiKey: string | undefined,
): void {
  const usesApiKey = kind === 'api' || kind === 'agent-sdk';
  const usesApiBase = kind === 'api';
  if (apiKey !== undefined && !usesApiKey) {
    warnStderr(`--${role}-api-key-env is ignored: the ${role} '${kind}' runner does not use it.`);
  }
  if (apiBase !== undefined && !usesApiBase) {
    warnStderr(`--${role}-api-base is ignored: the ${role} '${kind}' runner does not use it.`);
  }
}

function buildRunnerFromOverrides(
  role: 'planner',
  overrides: RunnerOverrides,
  existing: PlannerConfig,
): PlannerConfig | undefined;
function buildRunnerFromOverrides(
  role: 'implementer',
  overrides: RunnerOverrides,
  existing: ImplementerConfig,
): ImplementerConfig | undefined;
function buildRunnerFromOverrides(
  role: 'planner' | 'implementer',
  overrides: RunnerOverrides,
  existing: PlannerConfig | ImplementerConfig,
): PlannerConfig | ImplementerConfig | undefined {
  const { tool, model, command, apiBase, apiKey, args, outputFormat, contextLength } = overrides;
  if (
    tool === undefined &&
    model === undefined &&
    command === undefined &&
    apiBase === undefined &&
    apiKey === undefined &&
    args === undefined &&
    outputFormat === undefined &&
    contextLength === undefined
  ) {
    return undefined;
  }

  const baseOpts =
    tool !== undefined
      ? { kind: inferKindFromTool(tool), tool }
      : command !== undefined
        ? { kind: 'shell' as const }
        : apiBase !== undefined && existing.kind !== 'api'
          ? { kind: 'api' as const }
          : existingToOpts(existing);
  warnUnusableProviderOverrides(role, baseOpts.kind ?? existing.kind, apiBase, apiKey);
  const opts: BuildRunnerOpts = {
    ...baseOpts,
    ...(model !== undefined && { model }),
    ...(command !== undefined && { command }),
    ...(apiBase !== undefined && { apiBase }),
    ...(apiKey !== undefined && { apiKey }),
    ...(args !== undefined && { args }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...(contextLength !== undefined && { contextLength }),
    existing,
  };

  return role === 'planner'
    ? buildRunnerConfig('planner', opts)
    : buildRunnerConfig('implementer', opts);
}

function applyImplementerOverrides(overrides: RunnerOverrides, config: Config): Config {
  const profiles = config.implementerProfiles;
  if (!profiles) return applyRunnerOverrides('implementer', overrides, config);

  const defaultName = pickDefaultProfileName(profiles);
  const defaultProfile = defaultName === undefined ? undefined : profiles.profiles[defaultName];
  if (defaultName === undefined || defaultProfile === undefined) {
    return applyRunnerOverrides('implementer', overrides, config);
  }

  const existing = stripProfileMetadata(defaultProfile);
  const updated = buildRunnerFromOverrides('implementer', overrides, existing);
  if (updated === undefined) return config;

  return {
    ...config,
    implementer: updated,
    implementerProfiles: {
      ...profiles,
      profiles: {
        ...profiles.profiles,
        [defaultName]: mergeImplementerProfileMetadata(defaultProfile, updated),
      },
    },
  };
}

export function applyApproveOverride(config: Config, level: ApproveLevel): Config {
  return {
    ...config,
    workflow: {
      ...config.workflow,
      approve: level,
      ...(level === 'none' ? { autoApproveSpec: true, autoApprovePlan: true } : {}),
    },
  };
}

function parseOverrideOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  allowed: readonly string[],
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw configError.invalidOverride(label, value, `Must be one of: ${allowed.join(', ')}`);
  }
  return parsed.data;
}

export function applyCLIOverrides(config: Config, overrides: CLIOverrides): Config {
  let next = config;
  if (overrides.planner) {
    next = applyRunnerOverrides('planner', overrides.planner, next);
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    next = applyImplementerOverrides(
      {
        ...overrides.implementer,
        ...(overrides.implementer?.contextLength !== undefined ||
        overrides.contextLength !== undefined
          ? { contextLength: overrides.implementer?.contextLength ?? overrides.contextLength }
          : {}),
      },
      next,
    );
  }
  if (overrides.approve !== undefined) {
    const level = parseOverrideOrThrow(
      ApproveLevelSchema,
      overrides.approve,
      '--approve',
      APPROVE_LEVELS,
    );
    next = applyApproveOverride(next, level);
  }
  if (overrides.autoApprove !== undefined) {
    if (overrides.autoApprove && overrides.approve !== undefined && overrides.approve !== 'none') {
      warnStderr(`--approve ${overrides.approve} is overridden by --auto (approve=none).`);
    }
    next = {
      ...next,
      workflow: {
        ...next.workflow,
        autoApproveSpec: overrides.autoApprove,
        autoApprovePlan: overrides.autoApprove,
        ...(overrides.autoApprove ? { approve: 'none' satisfies ApproveLevel } : {}),
      },
    };
  }
  if (overrides.mode !== undefined) {
    const normalized = normalizeLegacyMode(overrides.mode);
    if (!normalized) {
      throw configError.invalidOverride(
        'workflow mode',
        overrides.mode,
        `Must be: ${WORKFLOW_MODES.join(', ')}`,
      );
    }
    next = { ...next, workflow: { ...next.workflow, mode: normalized } };
  }
  if (overrides.budget !== undefined) {
    if (!Number.isFinite(overrides.budget) || overrides.budget <= 0) {
      throw configError.invalidOverride('budget', overrides.budget, 'Must be a positive number.');
    }
    next = { ...next, workflow: { ...next.workflow, maxBudget: overrides.budget } };
  }
  if (overrides.plannerEffort !== undefined) {
    const effort = parseOverrideOrThrow(
      EffortLevelSchema,
      overrides.plannerEffort,
      '--planner-effort',
      EFFORT_LEVELS,
    );
    next = applyPlannerEffort(next, effort);
  }
  if (overrides.yolo) {
    const approval = next.approval ?? defaultApprovalConfig();
    next = {
      ...next,
      approval: { ...approval, enabled: false },
    };
  }
  return next;
}

function applyPlannerEffort(config: Config, effort: EffortLevel): Config {
  return { ...config, planner: { ...config.planner, effort } };
}
