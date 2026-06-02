import { z } from 'zod';
import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from './build-runner.js';
import {
  APPROVE_LEVELS,
  ApproveLevelSchema,
  EFFORT_LEVELS,
  EffortLevelSchema,
  WORKFLOW_MODES,
  WorkflowModeSchema,
  normalizeLegacyMode,
  type ApproveLevel,
  type EffortLevel,
} from '../../schemas/enums.js';
import { configError } from '../errors.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { Config } from '../../schemas/config.js';
import { defaultApprovalConfig } from '../../schemas/config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { WorkflowOpts } from '../../types/config-options.js';

const RunnerOverrideSchema = z.object({
  tool: z.string().optional(),
  model: z.string().optional(),
  command: z.string().optional(),
});

export const CLIOverridesSchema = z.object({
  planner: RunnerOverrideSchema.optional(),
  implementer: RunnerOverrideSchema.optional(),
  contextLength: z.number().optional(),
  autoApprove: z.boolean().optional(),
  approve: z.string().optional(),
  mode: z
    .preprocess(
      (m) => (typeof m === 'string' ? (normalizeLegacyMode(m) ?? m) : m),
      WorkflowModeSchema,
    )
    .optional(),
  budget: z.number().optional(),
  plannerEffort: z.string().optional(),
  yolo: z.boolean().optional(),
});

export type CLIOverrides = z.infer<typeof CLIOverridesSchema>;

export function workflowOptsToCLIOverrides(opts: WorkflowOpts): CLIOverrides {
  return {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto,
    approve: opts.approve,
    mode: opts.mode,
    budget: opts.budget,
    plannerEffort: opts.plannerEffort,
    yolo: opts.yolo,
  };
}

export interface RunnerOverrides {
  tool?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
  contextLength?: number | undefined;
}

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
  const { tool, model, command, contextLength } = overrides;
  if (
    tool === undefined &&
    model === undefined &&
    command === undefined &&
    contextLength === undefined
  ) {
    return config;
  }

  const existing = config[role];
  const opts: BuildRunnerOpts = {
    ...(tool !== undefined
      ? { kind: inferKindFromTool(tool), tool }
      : command !== undefined
        ? { kind: 'shell' }
        : existingToOpts(existing)),
    ...(model !== undefined && { model }),
    ...(command !== undefined && { command }),
    ...(contextLength !== undefined && { contextLength }),
    existing,
  };

  const updated =
    role === 'planner'
      ? buildRunnerConfig('planner', opts)
      : buildRunnerConfig('implementer', opts);
  return { ...config, [role]: updated };
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
    next = applyRunnerOverrides(
      'planner',
      {
        ...(overrides.planner.tool !== undefined && { tool: overrides.planner.tool }),
        ...(overrides.planner.model !== undefined && { model: overrides.planner.model }),
        ...(overrides.planner.command !== undefined && { command: overrides.planner.command }),
      },
      next,
    );
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    next = applyRunnerOverrides(
      'implementer',
      {
        ...(overrides.contextLength !== undefined && { contextLength: overrides.contextLength }),
        ...(overrides.implementer?.tool !== undefined && { tool: overrides.implementer.tool }),
        ...(overrides.implementer?.model !== undefined && { model: overrides.implementer.model }),
        ...(overrides.implementer?.command !== undefined && {
          command: overrides.implementer.command,
        }),
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
