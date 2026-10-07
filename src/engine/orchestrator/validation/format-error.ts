import { truncateByLines, truncateByTailLines } from '../../../utils/truncate.js';
import type { ValidationResult } from './result.js';
import type { ValidationAcceptance } from './acceptance.js';

const MAX_ERROR_LINES = 20;

const ERROR_MARK = /[×✖]|\b(?:error|Error|ERROR|FAIL)\b/;

const RULE_CHARS = /[━─]/g;

function blockingResult(
  results: readonly ValidationResult[],
  acceptance: ValidationAcceptance,
): ValidationResult | undefined {
  return results.find((r) => !r.passed && acceptance.blockingStages.includes(r.stage));
}

export function formatValidationError(
  results: ValidationResult[],
  acceptance: ValidationAcceptance,
): string {
  const blocking = results.filter((r) => !r.passed && acceptance.blockingStages.includes(r.stage));
  if (blocking.length === 0) return '';

  const header =
    acceptance.exemptStages.length > 0
      ? `${acceptance.exemptStages.length} pre-existing failure${
          acceptance.exemptStages.length === 1 ? '' : 's'
        } (${acceptance.exemptStages.join(', ')}), not to be fixed.`
      : 'Your previous code had an error. Fix it.';

  return [
    header,
    ...blocking.flatMap((result) => [
      `Error type: ${result.stage}`,
      `Error message: ${excerptErrorLines(result.error || result.output || '', result.stage)}`,
    ]),
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

/**
 * The blocking stage and the one line of its output that says what failed: the
 * first line naming a file the failure is attributed to, else the first error
 * line, else the first line. A tool notice that leads the output is passed over.
 */
export function validationFailureLine(
  results: readonly ValidationResult[],
  acceptance: ValidationAcceptance,
): string {
  const blocking = blockingResult(results, acceptance);
  if (!blocking) return '';
  const lines = (blocking.error || blocking.output || '')
    .split('\n')
    .map((line) => line.replace(RULE_CHARS, '').trim())
    .filter((line) => line.length > 0);
  const files = blocking.failureFiles ?? [];
  const line =
    lines.find((candidate) => files.some((file) => candidate.includes(file))) ??
    lines.find((candidate) => ERROR_MARK.test(candidate)) ??
    lines[0];
  return line === undefined ? `${blocking.stage} failed` : `${blocking.stage} failed: ${line}`;
}
