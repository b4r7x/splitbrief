import { IGNORE_RULE_ADDED } from '../../core/config/load/document.js';
import { SOFT_SEP } from '../../core/separators.js';
import { assertNever } from '../../utils/type-guards.js';
import { fileErrorReason, toErrorMessage } from '../../utils/format-errors.js';
import { feedbackStore } from '../ui/feedback.js';
import type { ConfigSaveResult } from './config.js';

/**
 * The lines of a config error. A refused document reads an intro line that ends in `:` and names
 * the file, then one `field: rule` line per issue; a later line that only introduces more lines is
 * not an issue.
 */
export function configErrorLines(message: string): { intro: string; issues: string[] } {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const isIntro = (line: string) => line.endsWith(':');
  const [first = ''] = lines;
  return { intro: isIntro(first) ? first : '', issues: lines.filter((line) => !isIntro(line)) };
}

/**
 * Why a save failed, on one line. The failure itself says only where the save went; its cause says
 * why, which for a refused document is each field and the rule it broke, and for a refused write
 * its words and the file.
 */
function saveFailureReason(error: Error): string {
  const source = error.cause instanceof Error ? error.cause : error;
  if (fileErrorReason(source) !== undefined) return toErrorMessage(source);
  const { issues } = configErrorLines(source.message);
  return issues.length === 0 ? source.message : issues.join('; ');
}

/**
 * The one line every surface shows for a save that landed; `subject` names what was saved. The save
 * that added the `.splitbrief/` rule to `.gitignore` says so on the same line.
 */
export function formatConfigSaveSuccess(
  subject: string,
  saved: Readonly<{ ignoreRuleAdded: boolean }>,
): string {
  const line = `Saved ${subject} to .splitbrief/config.yaml`;
  return saved.ignoreRuleAdded ? `${line}${SOFT_SEP}${IGNORE_RULE_ADDED}` : line;
}

/** The one line every surface shows for a failed save. */
export function formatConfigSaveFailure(error: Error): string {
  return `Failed to save config: ${saveFailureReason(error)}`;
}

export function reportConfigSaveFailure(
  result: ConfigSaveResult,
  redact: (message: string) => string = (message) => message,
): result is Exclude<ConfigSaveResult, { kind: 'saved' }> {
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
      feedbackStore.setError(
        'Config changed on disk. SPLITBRIEF loaded it; make your change again.',
      );
      return true;
    default:
      return assertNever(result);
  }
}
