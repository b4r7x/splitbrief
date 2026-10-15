import { assertNever } from '../../utils/type-guards.js';
import { feedbackStore } from '../ui/feedback.js';
import type { ConfigSaveResult } from './config.js';

/**
 * Why a save failed, on one line. The failure itself says only where the save went; its cause says
 * why, which for a refused document is each field and the rule it broke. A line that only
 * introduces that list is dropped.
 */
function saveFailureReason(error: Error): string {
  const source = error.cause instanceof Error ? error.cause : error;
  const lines = source.message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith(':'));
  return lines.length === 0 ? source.message : lines.join('; ');
}

/** The one line every surface shows for a save that landed; `subject` names what was saved. */
export function formatConfigSaveSuccess(subject: string): string {
  return `Saved ${subject} to .splitbrief/config.yaml`;
}

/** The one line every surface shows for a failed save. */
export function formatConfigSaveFailure(error: Error): string {
  return `Failed to save config: ${saveFailureReason(error)}`;
}

export function reportConfigSaveFailure(
  result: ConfigSaveResult,
  redact: (message: string) => string = (message) => message,
): boolean {
  switch (result.kind) {
    case 'saved':
      return false;
    case 'failure':
      feedbackStore.setError(redact(formatConfigSaveFailure(result.error)));
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
