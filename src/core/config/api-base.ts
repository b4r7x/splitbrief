import { validateApiBaseUrl } from '../providers/validate-api-base.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function apiBaseValidationError(apiBase: string): string | undefined {
  try {
    validateApiBaseUrl(apiBase);
    return undefined;
  } catch (err) {
    return toErrorMessage(err);
  }
}
