import { ConfigSchema } from '../../../schemas/config.js';
import { apiKeyErrors } from './credentials.js';
import { securityWarnings } from './warnings.js';
import type { ConfigValidation } from './types.js';

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const errors: ConfigValidation['errors'] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = result.success ? securityWarnings(result.data) : [];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
