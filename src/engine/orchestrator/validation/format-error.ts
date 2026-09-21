import { truncateByLines, truncateByTailLines } from '../../../utils/truncate.js';
import type { ValidationResult } from './result.js';
import type { ValidationAcceptance } from './acceptance.js';

const MAX_ERROR_LINES = 20;

export function formatValidationError(
  results: ValidationResult[],
  acceptance: ValidationAcceptance,
): string {
  const blocking = results.find((r) => !r.passed && acceptance.blockingStages.includes(r.stage));
  if (!blocking) return '';

  const errorLines = excerptErrorLines(blocking.error || blocking.output || '', blocking.stage);
  const header =
    acceptance.exemptStages.length > 0
      ? `${acceptance.exemptStages.length} pre-existing failure${
          acceptance.exemptStages.length === 1 ? '' : 's'
        } (${acceptance.exemptStages.join(', ')}), not to be fixed.`
      : 'Your previous code had an error. Fix it.';

  return [
    header,
    `Error type: ${blocking.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

/**
 * A test runner puts its failure summary last. A linter or type checker puts
 * its diagnostics first but may open with config notices, so both ends are
 * kept: a preamble must not hide the diagnostic from the implementer.
 */
function excerptErrorLines(text: string, stage: ValidationResult['stage']): string {
  if (stage === 'test') return truncateByTailLines(text, MAX_ERROR_LINES);
  const lines = text.split('\n');
  if (lines.length <= MAX_ERROR_LINES * 2) return text;
  return [
    truncateByLines(text, MAX_ERROR_LINES),
    '…',
    truncateByTailLines(text, MAX_ERROR_LINES),
  ].join('\n');
}
