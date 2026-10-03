import type { WorkflowOpts } from '../core/types/config-options.js';
import type { Config } from '../core/schemas/config.js';
import { loadConfig } from '../core/config/load/io.js';
import type { ConfigDocumentSnapshot } from '../core/config/load/document.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../core/config/runtime/effective-config.js';

export type ResolvedRunConfig = Readonly<{
  config: Config;
  persistedConfig: Config;
  persistenceSnapshot: ConfigDocumentSnapshot;
}>;

export function resolveRunConfigWithBase(args: {
  projectDir: string;
  opts: WorkflowOpts;
}): ResolvedRunConfig {
  const loadedResult = loadConfig(args.projectDir);
  const { config: loaded, loaderDiagnostics, rawBytes, rawYaml, document, revision } = loadedResult;
  const overrides = workflowOptsToCLIOverrides(args.opts);
  const { config, warnings } = resolveEffectiveConfig({
    base: loaded,
    overrides,
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  return {
    config,
    persistedConfig: loaded,
    persistenceSnapshot: { rawBytes, rawYaml, document, revision },
  };
}

export function resolveRunConfig(args: { projectDir: string; opts: WorkflowOpts }): Config {
  const { config } = resolveRunConfigWithBase(args);
  return config;
}
