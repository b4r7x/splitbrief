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

  const errorText = blocking.error || blocking.output || '';
  const errorLines =
    blocking.stage === 'test'
      ? truncateByTailLines(errorText, MAX_ERROR_LINES)
      : truncateByLines(errorText, MAX_ERROR_LINES);
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
