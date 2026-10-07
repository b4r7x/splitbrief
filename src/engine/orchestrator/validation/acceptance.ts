import type { ValidationStage } from '../../../core/schemas/enums.js';
import { GATE_ORDER } from '../../../core/pipeline-spec/gates.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { stageFailureKeys } from './extract-failure-keys.js';
import type { ValidationResult } from './result.js';
import type { FullSuiteFailureKeys } from './types.js';

type ValidationFailureKeys = Partial<Record<ValidationStage, ReadonlySet<string>>>;

export type ValidationAcceptance = {
  accepted: boolean;
  exemptStages: readonly ValidationStage[];
  blockingStages: readonly ValidationStage[];
};

function evidenceNamesChangedFile(
  result: ValidationResult,
  changedFiles: readonly string[],
): boolean {
  if (result.failureFiles === undefined) return true;
  const normalizedChanged = new Set(changedFiles.map(normalizeProjectRelativePath));
  return result.failureFiles.some((file) =>
    normalizedChanged.has(normalizeProjectRelativePath(file)),
  );
}

function isSubset(after: readonly string[], baseline: ReadonlySet<string>): boolean {
  return after.every((key) => baseline.has(key));
}

function failuresAreKnown(
  result: ValidationResult,
  baselineFailureKeys: ValidationFailureKeys | undefined,
): boolean {
  const baseline = baselineFailureKeys?.[result.stage];
  if (baseline === undefined) return true;
  return isSubset(stageFailureKeys(result), baseline);
}

export function decideValidationAcceptance(opts: {
  results: readonly ValidationResult[];
  baselineFailingStages: ReadonlySet<ValidationStage>;
  baselineFailureKeys?: ValidationFailureKeys | undefined;
  changedFiles: readonly string[];
}): ValidationAcceptance {
  const exemptStages: ValidationStage[] = [];
  const blockingStages: ValidationStage[] = [];
  for (const result of opts.results) {
    if (result.passed) continue;
    if (
      opts.baselineFailingStages.has(result.stage) &&
      failuresAreKnown(result, opts.baselineFailureKeys) &&
      !evidenceNamesChangedFile(result, opts.changedFiles)
    ) {
      exemptStages.push(result.stage);
    } else {
      blockingStages.push(result.stage);
    }
  }
  return { accepted: blockingStages.length === 0, exemptStages, blockingStages };
}

export function acceptValidationResults(
  results: ValidationResult[],
  baseline: FullSuiteFailureKeys | undefined,
  changedFiles: readonly string[],
) {
  const baselineFailureKeys: ValidationFailureKeys = {};
  for (const stage of GATE_ORDER) {
    const keys = baseline?.[stage];
    if (keys !== undefined) baselineFailureKeys[stage] = new Set(keys);
  }
  return decideValidationAcceptance({
    results,
    baselineFailureKeys,
    changedFiles,
    baselineFailingStages: new Set(GATE_ORDER.filter((stage) => baseline?.[stage] !== undefined)),
  });
}
