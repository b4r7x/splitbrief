import type { Config } from '../../schemas/config.js';
import { validateConfig } from '../load/validation/config.js';
import type { ConfigError } from '../load/validation/types.js';
import { dedupeConfigWarnings, formatConfigLoaderDiagnostic } from '../load/io.js';
import type { ConfigLoaderDiagnostic } from '../load/io.js';
import { configError } from '../errors.js';
import { warnStderr } from '../../../lib/warn.js';
import { RETIRED_WORKFLOW_MODE, RETIRED_WORKFLOW_MODE_NOTICE } from '../../schemas/enums.js';
import { applyCLIOverrides } from './overrides/apply.js';
import type { CLIOverrides } from './overrides/schema.js';

export type EffectiveConfigWarning =
  | { source: 'loader'; diagnostic: ConfigLoaderDiagnostic }
  | { source: 'validation'; message: string };

export interface EffectiveConfigResult {
  config: Config;
  warnings: EffectiveConfigWarning[];
}

function formatValidationErrors(errors: ConfigError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

export function formatEffectiveConfigWarning(warning: EffectiveConfigWarning): string {
  switch (warning.source) {
    case 'loader':
      return formatConfigLoaderDiagnostic(warning.diagnostic);
    case 'validation':
      return warning.message;
    default: {
      const _exhaustive: never = warning;
      return _exhaustive;
    }
  }
}

export function formatEffectiveConfigWarnings(
  warnings: readonly EffectiveConfigWarning[],
): string[] {
  return dedupeConfigWarnings(warnings.map(formatEffectiveConfigWarning));
}

export function emitEffectiveConfigWarnings(warnings: readonly EffectiveConfigWarning[]): void {
  for (const message of formatEffectiveConfigWarnings(warnings)) warnStderr(`⚠ ${message}`);
}

export function resolveEffectiveConfig(opts: {
  base: Config;
  overrides?: CLIOverrides | undefined;
  loaderDiagnostics?: ConfigLoaderDiagnostic[] | undefined;
}): EffectiveConfigResult {
  const config = applyCLIOverrides(opts.base, opts.overrides ?? {});
  const { errors, warnings: validationWarnings, data } = validateConfig(config);

  if (errors.length > 0) {
    throw configError.validationFailed('effective config', formatValidationErrors(errors));
  }
  if (!data) {
    throw configError.validationFailed('effective config', [
      'Unexpected validation state: no data after successful validation',
    ]);
  }

  const retiredModeFlag =
    opts.overrides?.mode?.trim().toLowerCase() === RETIRED_WORKFLOW_MODE
      ? [{ source: 'validation', message: RETIRED_WORKFLOW_MODE_NOTICE } as const]
      : [];

  return {
    config: data,
    warnings: [
      ...(opts.loaderDiagnostics ?? []).map(
        (diagnostic): EffectiveConfigWarning => ({ source: 'loader', diagnostic }),
      ),
      ...validationWarnings.map(
        (message): EffectiveConfigWarning => ({ source: 'validation', message }),
      ),
      ...retiredModeFlag,
    ],
  };
}
