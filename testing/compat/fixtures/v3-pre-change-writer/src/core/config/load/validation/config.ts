import type { z } from 'zod';
import { ConfigSchema } from '../../../schemas/config.js';
import { apiKeyErrors } from './credentials.js';
import { securityWarnings } from './warnings.js';
import type { ConfigError, ConfigValidation } from './types.js';

const UNKNOWN_KEY_MESSAGE =
  'Unknown config key — remove it or use the current spelling from docs/CONFIGURATION.md.';

// Zod reports every unrecognized key of an object under the object's own path,
// which would name `workflow` instead of `workflow.autoApproveSpec`. Expanding
// one error per key is what makes the offending path readable.
function issueErrors(issue: z.core.$ZodIssue): ConfigError[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: [...issue.path, key].join('.'),
      message: UNKNOWN_KEY_MESSAGE,
    }));
  }
  return [{ path: issue.path.join('.'), message: issue.message }];
}

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const errors: ConfigValidation['errors'] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(...issueErrors(issue));
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = result.success ? securityWarnings(result.data) : [];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
