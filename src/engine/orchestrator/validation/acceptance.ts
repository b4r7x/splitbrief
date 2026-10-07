import type { ValidationStage } from '../../../core/schemas/enums.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { stageFailureKeys } from './extract-failure-keys.js';
import type { ValidationResult } from './result.js';

export type ValidationAcceptance = {
  accepted: boolean;
  exemptStages: readonly ValidationStage[];
  blockingStages: readonly ValidationStage[];
};

export function evidenceNamesChangedFile(
  result: ValidationResult,
  changedFiles: readonly string[],
): boolean {
  if (result.failureFiles === undefined) return true;
  const normalizedChanged = new Set(changedFiles.map(normalizeProjectRelativePath));
  return result.failureFiles.some((file) =>
    normalizedChanged.has(normalizeProjectRelativePath(file)),
  );
}

export function acceptValidationResults(
  results: readonly ValidationResult[],
  changedFiles: readonly string[],
): ValidationAcceptance {
  const exemptStages: ValidationStage[] = [];
  const blockingStages: ValidationStage[] = [];
  for (const result of results) {
    if (result.passed || result.skipped === true) continue;
    const preExisting = result.preExisting;
    if (
      preExisting !== undefined &&
      stageFailureKeys(result).every((key) => preExisting.includes(key)) &&
      !evidenceNamesChangedFile(result, changedFiles)
    ) {
      exemptStages.push(result.stage);
    } else {
      blockingStages.push(result.stage);
    }
  }
  return { accepted: blockingStages.length === 0, exemptStages, blockingStages };
}
