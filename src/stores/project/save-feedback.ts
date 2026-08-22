import { feedbackStore } from '../ui/feedback.js';
import type { ConfigSaveResult } from './config.js';

export function reportConfigSaveFailure(
  result: ConfigSaveResult,
  redact: (message: string) => string = (message) => message,
): boolean {
  if (result.kind === 'saved') return false;
  if (result.kind === 'failure') {
    feedbackStore.setError(redact(`Failed to save config: ${result.error.message}`));
  } else if (result.kind === 'durability-uncertain') {
    feedbackStore.setError(redact(`Config save could not be confirmed: ${result.warning}`));
  } else {
    feedbackStore.setError('Config changed on disk. Reload before saving again.');
  }
  return true;
}
