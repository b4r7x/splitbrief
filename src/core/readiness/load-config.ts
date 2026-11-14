import { toErrorMessage } from '../../utils/format/errors.js';
import { getIsolationStrategy } from '../config/accessors/values.js';
import { configErrorDiagnosticState } from '../config/errors.js';
import { readConfigDocument, type ConfigDocumentSnapshot } from '../config/load/document.js';
import { loadConfig } from '../config/load/io.js';
import { resolveEffectiveConfig } from '../config/runtime/effective-config.js';
import { workflowOptsToCLIOverrides } from '../config/runtime/overrides/from-options.js';
import type { Config } from '../schemas/config.js';
import type { IsolationStrategy } from '../schemas/enums.js';
import type { ConfigReadinessInput } from './checks/config.js';
import type { CollectReadinessOptions } from './collect.js';

export function loadReadinessConfig(
  options: CollectReadinessOptions,
  filePath: string,
  configExists: boolean,
): {
  config?: Config | undefined;
  configLoad: ConfigReadinessInput;
  isolation?: IsolationStrategy | undefined;
} {
  if (options.config) {
    return {
      config: options.config,
      isolation: configuredIsolation(
        options.config,
        readConfigDocument(options.projectDir).document,
      ),
      configLoad: {
        state: configExists ? 'loaded' : 'missing',
        path: filePath,
        warnings: options.configWarnings ?? [],
      },
    };
  }

  if (!configExists) {
    return {
      configLoad: {
        state: 'missing',
        path: filePath,
        warnings: [],
      },
    };
  }

  try {
    const loaded = loadConfig(options.projectDir);
    const cliOverrides = workflowOptsToCLIOverrides(options.opts ?? {});
    const { config, warnings } = resolveEffectiveConfig({
      base: loaded.config,
      overrides: cliOverrides,
      loaderDiagnostics: loaded.loaderDiagnostics,
    });
    return {
      config,
      configLoad: { state: 'loaded', path: filePath, warnings },
      isolation: configuredIsolation(config, loaded.document),
    };
  } catch (err) {
    const diagnosticState = configErrorDiagnosticState(err);
    return {
      configLoad: {
        state: 'invalid',
        path: filePath,
        warnings: [],
        error: toErrorMessage(err, { preserveLineBreaks: true }),
        ...(diagnosticState !== undefined && { diagnosticState }),
      },
    };
  }
}

/** The loaded config always carries a default; only the file says whether the user chose one. */
function configuredIsolation(
  config: Config,
  document: ConfigDocumentSnapshot['document'],
): IsolationStrategy | undefined {
  return document.hasIn(['workflow', 'isolation']) ? getIsolationStrategy(config) : undefined;
}
