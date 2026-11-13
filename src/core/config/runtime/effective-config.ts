import type { Config } from '../../schemas/config.js';
import { validateConfig } from '../load/validation/config.js';
import type { ConfigError } from '../load/validation/types.js';
import type { ConfigLoaderDiagnostic } from '../load/io.js';
import { configError } from '../errors.js';
import { applyCLIOverrides } from './overrides/apply.js';
import type { IgnoredFlag } from './overrides/runner.js';
import type { CLIOverrides } from './overrides/schema.js';

export type EffectiveConfigWarning =
  | ConfigLoaderDiagnostic
  | (Readonly<{ kind: 'ignored-flag' }> & IgnoredFlag);

export interface EffectiveConfigResult {
  config: Config;
  warnings: EffectiveConfigWarning[];
}

function formatValidationErrors(errors: ConfigError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

export function resolveEffectiveConfig(opts: {
  base: Config;
  overrides?: CLIOverrides | undefined;
  loaderDiagnostics?: ConfigLoaderDiagnostic[] | undefined;
}): EffectiveConfigResult {
  const { config, ignoredFlags } = applyCLIOverrides(opts.base, opts.overrides ?? {});
  const { errors, data } = validateConfig(config);

  if (errors.length > 0) {
    throw configError.validationFailed('effective config', formatValidationErrors(errors));
  }
  if (!data) {
    throw configError.validationFailed('effective config', [
      'Unexpected validation state: no data after successful validation',
    ]);
  }

  return {
    config: data,
    warnings: [
      ...ignoredFlags.map((flag) => ({ kind: 'ignored-flag' as const, ...flag })),
      ...(opts.loaderDiagnostics ?? []),
    ],
  };
}
