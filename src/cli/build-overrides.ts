import type { WorkflowOpts } from '../core/types/config-options.js';
import { loadConfig } from '../core/config/load/io.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';
import {
  type EffectiveConfigResult,
  resolveEffectiveConfig,
} from '../core/config/runtime/effective-config.js';

export function resolveRunConfig(args: {
  projectDir: string;
  opts: WorkflowOpts;
}): EffectiveConfigResult {
  const { config: loaded, loaderDiagnostics } = loadConfig(args.projectDir);
  const overrides = workflowOptsToCLIOverrides(args.opts);
  return resolveEffectiveConfig({
    base: loaded,
    overrides,
    loaderDiagnostics,
  });
}
