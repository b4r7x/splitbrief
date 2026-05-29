import type { WorkflowOpts } from '../core/types/config-options.js';
import type { CLIOverrides } from '../core/config/runtime/overrides.js';
import type { Config } from '../core/schemas/config.js';
import type { CollectedReadiness } from '../core/readiness/collect.js';
import { loadConfig } from '../core/config/load/load.js';
import { applyCLIOverrides } from '../core/config/runtime/overrides.js';
import { warnStderr } from '../lib/warn.js';

export function buildCLIOverrides(opts: WorkflowOpts): CLIOverrides {
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

export function printConfigWarnings(warnings: readonly string[]): void {
  for (const w of warnings) warnStderr(`⚠ ${w}`);
}

export function resolveRunConfig(args: {
  projectDir: string;
  opts: WorkflowOpts;
  readiness?: CollectedReadiness | undefined;
  autoApprove?: boolean | undefined;
}): Config {
  const loadedResult = args.readiness?.config
    ? { config: args.readiness.config, warnings: args.readiness.warnings }
    : loadConfig(args.projectDir);
  const { config: loaded, warnings } = loadedResult;
  printConfigWarnings(warnings);

  const overrides = buildCLIOverrides(args.opts);
  return applyCLIOverrides(
    loaded,
    args.autoApprove !== undefined ? { ...overrides, autoApprove: args.autoApprove } : overrides,
  );
}
