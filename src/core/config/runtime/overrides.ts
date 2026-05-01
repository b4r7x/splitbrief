import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from './build-runner.js';
import {
  APPROVE_LEVELS,
  ApproveLevelSchema,
  EFFORT_LEVELS,
  EffortLevelSchema,
  WORKFLOW_MODES,
  normalizeLegacyMode,
  type ApproveLevel,
  type EffortLevel,
  type WorkflowMode,
} from '../../schemas/enums.js';
import { configError } from '../errors.js';
import type { Config } from '../../schemas/config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';

export interface CLIOverrides {
  planner?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  implementer?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  contextLength?: number | undefined;
  autoApprove?: boolean | undefined;
  approve?: string | undefined;
  mode?: WorkflowMode | undefined;
  budget?: number | undefined;
  plannerEffort?: string | undefined;
  yolo?: boolean | undefined;
}

export interface RunnerOverrides {
  tool?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
  contextLength?: number | undefined;
}

export function existingToOpts(existing: PlannerConfig | ImplementerConfig): BuildRunnerOpts {
  if (existing.kind === 'cli') {
    return { kind: 'cli', tool: existing.tool, ...('args' in existing && { args: existing.args }), ...('outputFormat' in existing && { outputFormat: existing.outputFormat }) };
  }
  if (existing.kind === 'api') {
    return { kind: 'api', tool: existing.provider, apiBase: existing.apiBase, ...('apiKey' in existing && { apiKey: existing.apiKey }) };
  }
  if (existing.kind === 'shell' || existing.kind === 'agent') {
    return { kind: existing.kind, command: existing.command, ...('args' in existing && { args: existing.args }), ...('outputFormat' in existing && { outputFormat: existing.outputFormat }) };
  }
  return { kind: 'agent-sdk', ...('apiKey' in existing && { apiKey: existing.apiKey }) };
}

export function applyRunnerOverrides(role: 'planner' | 'implementer', overrides: RunnerOverrides, config: Config): Config {
  const { tool, model, command, contextLength } = overrides;
  if (tool === undefined && model === undefined && command === undefined && contextLength === undefined) {
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

  const updated = role === 'planner' ? buildRunnerConfig('planner', opts) : buildRunnerConfig('implementer', opts);
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

export function applyCLIOverrides(config: Config, overrides: CLIOverrides): Config {
  let next = config;
  if (overrides.planner) {
    next = applyRunnerOverrides('planner', {
      ...(overrides.planner.tool !== undefined && { tool: overrides.planner.tool }),
      ...(overrides.planner.model !== undefined && { model: overrides.planner.model }),
      ...(overrides.planner.command !== undefined && { command: overrides.planner.command }),
    }, next);
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    next = applyRunnerOverrides('implementer', {
      ...(overrides.contextLength !== undefined && { contextLength: overrides.contextLength }),
      ...(overrides.implementer?.tool !== undefined && { tool: overrides.implementer.tool }),
      ...(overrides.implementer?.model !== undefined && { model: overrides.implementer.model }),
      ...(overrides.implementer?.command !== undefined && { command: overrides.implementer.command }),
    }, next);
  }
  if (overrides.approve !== undefined) {
    const parsed = ApproveLevelSchema.safeParse(overrides.approve);
    if (!parsed.success) {
      throw configError.invalidOverride(
        '--approve',
        overrides.approve,
        `Must be one of: ${APPROVE_LEVELS.join(', ')}`,
      );
    }
    next = applyApproveOverride(next, parsed.data);
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
      throw configError.invalidOverride(
        'budget',
        overrides.budget,
        'Must be a positive number.',
      );
    }
    next = { ...next, workflow: { ...next.workflow, maxBudget: overrides.budget } };
  }
  if (overrides.plannerEffort !== undefined) {
    const parsed = EffortLevelSchema.safeParse(overrides.plannerEffort);
    if (!parsed.success) {
      throw configError.invalidOverride(
        '--planner-effort',
        overrides.plannerEffort,
        `Must be one of: ${EFFORT_LEVELS.join(', ')}`,
      );
    }
    next = applyPlannerEffort(next, parsed.data);
  }
  if (overrides.yolo) {
    const approval = next.approval ?? { enabled: true, feedRejectionsToPlanner: true };
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
