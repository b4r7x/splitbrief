import type { WorkflowOpts } from '../core/types/config-options.js';
import type { CLIOverrides } from '../core/config/runtime/overrides.js';
import type { Config } from '../core/schemas/config.js';
import type { CollectedReadiness } from '../core/readiness/collect.js';
import { loadConfig } from '../core/config/load/io.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides.js';
import { resolveEffectiveConfig } from '../core/config/runtime/effective-config.js';
import { warnStderr } from '../lib/warn.js';

export function buildCLIOverrides(opts: WorkflowOpts): CLIOverrides {
  return workflowOptsToCLIOverrides(opts);
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
  const overrides = buildCLIOverrides(args.opts);
  const effectiveOverrides =
    args.autoApprove !== undefined ? { ...overrides, autoApprove: args.autoApprove } : overrides;
  const { config, warnings: effectiveWarnings } = resolveEffectiveConfig({
    base: loaded,
    overrides: effectiveOverrides,
    baseWarnings: warnings,
  });
  printConfigWarnings(effectiveWarnings);
  return config;
}
