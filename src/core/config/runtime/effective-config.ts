import type { Config } from '../../schemas/config.js';
import { validateConfig, type ConfigError } from '../load/validate.js';
import { configError } from '../errors.js';
import { applyCLIOverrides, type CLIOverrides } from './overrides.js';

export interface EffectiveConfigResult {
  config: Config;
  warnings: string[];
}

function formatValidationErrors(errors: ConfigError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

export function resolveEffectiveConfig(opts: {
  base: Config;
  overrides?: CLIOverrides | undefined;
  baseWarnings?: string[] | undefined;
}): EffectiveConfigResult {
  const config = applyCLIOverrides(opts.base, opts.overrides ?? {});
  const { errors, warnings, data } = validateConfig(config);

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
    warnings,
  };
}
