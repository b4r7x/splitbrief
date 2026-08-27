import { assertNever } from '../../utils/type-guards.js';
import { feedbackStore } from '../ui/feedback.js';
import type { ConfigSaveResult } from './config.js';

export function reportConfigSaveFailure(
  result: ConfigSaveResult,
  redact: (message: string) => string = (message) => message,
): boolean {
  switch (result.kind) {
    case 'saved':
      return false;
    case 'failure':
      feedbackStore.setError(redact(`Failed to save config: ${result.error.message}`));
      return true;
    case 'durability-uncertain':
      feedbackStore.setError(redact(`Config save could not be confirmed: ${result.warning}`));
      return true;
    case 'conflict':
      feedbackStore.setError('Config changed on disk. Reload before saving again.');
      return true;
    default:
      return assertNever(result);
  }
}
