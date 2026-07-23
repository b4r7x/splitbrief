import { truncateByLines, truncateByTailLines } from '../../../utils/truncate.js';
import type { ValidationResult } from './result.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';

const MAX_ERROR_LINES = 20;

export function formatValidationError(
  results: ValidationResult[],
  baselineFailingStages?: ReadonlySet<ValidationStage>,
): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorText = failed.error || failed.output || '';
  const errorLines =
    failed.stage === 'test'
      ? truncateByTailLines(errorText, MAX_ERROR_LINES)
      : truncateByLines(errorText, MAX_ERROR_LINES);
  const preExisting =
    baselineFailingStages !== undefined
      ? results.filter((r) => !r.passed && baselineFailingStages.has(r.stage)).length
      : 0;

  const header =
    preExisting > 0 && baselineFailingStages?.has(failed.stage)
      ? `${preExisting} pre-existing failure${preExisting === 1 ? '' : 's'} (not caused by this task). Fix the current error.`
      : 'Your previous code had an error. Fix it.';

  return [
    header,
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}
