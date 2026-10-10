import type { WorkflowOpts } from '../core/types/config-options.js';
import type { Config } from '../core/schemas/config.js';
import { loadConfig } from '../core/config/load/io.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../core/config/runtime/effective-config.js';

export function resolveRunConfig(args: { projectDir: string; opts: WorkflowOpts }): Config {
  const { config: loaded, loaderDiagnostics } = loadConfig(args.projectDir);
  const overrides = workflowOptsToCLIOverrides(args.opts);
  const { config, warnings } = resolveEffectiveConfig({
    base: loaded,
    overrides,
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  return config;
}
