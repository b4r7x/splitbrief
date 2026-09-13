import type { ValidationStage } from '../../../core/schemas/enums.js';
import type { ValidationStageCommands } from '../../events/types.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { extractFailureKeys } from './extract-failure-keys.js';
import type { ValidationResult } from './result.js';

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

function matchesBaselineCommand(
  result: ValidationResult,
  baselineCommands: ValidationStageCommands | undefined,
): boolean {
  const probed = baselineCommands?.[result.stage];
  return probed === undefined || probed === result.command;
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
  return isSubset(extractFailureKeys(result.error ?? result.output ?? ''), baseline);
}

export function decideValidationAcceptance(opts: {
  results: readonly ValidationResult[];
  baselineFailingStages: ReadonlySet<ValidationStage>;
  baselineCommands?: ValidationStageCommands | undefined;
  baselineFailureKeys?: ValidationFailureKeys | undefined;
  changedFiles: readonly string[];
}): ValidationAcceptance {
  const exemptStages: ValidationStage[] = [];
  const blockingStages: ValidationStage[] = [];
  for (const result of opts.results) {
    if (result.passed) continue;
    if (
      opts.baselineFailingStages.has(result.stage) &&
      matchesBaselineCommand(result, opts.baselineCommands) &&
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
