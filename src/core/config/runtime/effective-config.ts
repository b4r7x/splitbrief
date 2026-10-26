import type { Config } from '../../schemas/config.js';
import { validateConfig } from '../load/validation/config.js';
import type { ConfigError } from '../load/validation/types.js';
import { formatConfigLoaderDiagnostics } from '../load/io.js';
import type { ConfigLoaderDiagnostic } from '../load/io.js';
import { configError } from '../errors.js';
import { warnStderr } from '../../../lib/warn.js';
import { applyCLIOverrides } from './overrides/apply.js';
import type { CLIOverrides } from './overrides/schema.js';

export interface EffectiveConfigResult {
  config: Config;
  warnings: ConfigLoaderDiagnostic[];
}

function formatValidationErrors(errors: ConfigError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

// A command resolves its config more than once (the screen's store, the run, a recovery action),
// so each notice about a project's config is told once a process.
const toldNotices = new Set<string>();

export function emitEffectiveConfigWarnings(
  projectDir: string,
  warnings: readonly ConfigLoaderDiagnostic[],
): void {
  for (const message of formatConfigLoaderDiagnostics(warnings)) {
    const notice = `${projectDir}\0${message}`;
    if (toldNotices.has(notice)) continue;
    toldNotices.add(notice);
    warnStderr(`⚠ ${message}`);
  }
}

export function resolveEffectiveConfig(opts: {
  base: Config;
  overrides?: CLIOverrides | undefined;
  loaderDiagnostics?: ConfigLoaderDiagnostic[] | undefined;
}): EffectiveConfigResult {
  const config = applyCLIOverrides(opts.base, opts.overrides ?? {});
  const { errors, data } = validateConfig(config);

  if (errors.length > 0) {
    throw configError.validationFailed('effective config', formatValidationErrors(errors));
  }
  if (!data) {
    throw configError.validationFailed('effective config', [
      'Unexpected validation state: no data after successful validation',
    ]);
  }

  return { config: data, warnings: opts.loaderDiagnostics ?? [] };
}
