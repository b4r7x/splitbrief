import type { WorkflowOpts } from '../core/types/config-options.js';
import type { Config } from '../core/schemas/config.js';
import type { ApproveLevel } from '../core/schemas/enums.js';
import { loadConfig, type ConfigDocumentSnapshot } from '../core/config/load/io.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../core/config/runtime/effective-config.js';
import type { EffectiveConfigWarning } from '../core/config/runtime/effective-config.js';

export type ResolvedRunConfig = Readonly<{
  config: Config;
  persistedConfig: Config;
  persistenceSnapshot: ConfigDocumentSnapshot;
}>;

export function printConfigWarnings(warnings: readonly string[]): void {
  emitEffectiveConfigWarnings(
    warnings.map((message): EffectiveConfigWarning => ({ source: 'validation', message })),
  );
}

export function resolveRunConfigWithBase(args: {
  projectDir: string;
  opts: WorkflowOpts;
  defaultApprove?: ApproveLevel | undefined;
}): ResolvedRunConfig {
  const loadedResult = loadConfig(args.projectDir);
  const { config: loaded, loaderDiagnostics, rawBytes, rawYaml, document, revision } = loadedResult;
  const overrides = workflowOptsToCLIOverrides(args.opts);
  const { config, warnings } = resolveEffectiveConfig({
    base: loaded,
    overrides: { ...overrides, approve: overrides.approve ?? args.defaultApprove },
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  return {
    config,
    persistedConfig: loaded,
    persistenceSnapshot: { rawBytes, rawYaml, document, revision },
  };
}

export function resolveRunConfig(args: {
  projectDir: string;
  opts: WorkflowOpts;
  defaultApprove?: ApproveLevel | undefined;
}): Config {
  const { config } = resolveRunConfigWithBase(args);
  return config;
}
