import type { ValidationStage } from '../../../core/schemas/enums.js';
import type { ValidationStageCommands } from '../../events/types.js';
import type { ValidationResult } from './result.js';

export type ValidationAcceptance = {
  accepted: boolean;
  exemptStages: readonly ValidationStage[];
  blockingStages: readonly ValidationStage[];
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function evidenceNamesChangedFile(
  result: ValidationResult,
  changedFiles: readonly string[],
): boolean {
  if (result.failureFiles === undefined) return true;
  const normalizedChanged = new Set(changedFiles.map(normalizePath));
  return result.failureFiles.some((file) => normalizedChanged.has(normalizePath(file)));
}

function matchesBaselineCommand(
  result: ValidationResult,
  baselineCommands: ValidationStageCommands | undefined,
): boolean {
  const probed = baselineCommands?.[result.stage];
  return probed === undefined || probed === result.command;
}

export function decideValidationAcceptance(opts: {
  results: readonly ValidationResult[];
  baselineFailingStages: ReadonlySet<ValidationStage>;
  baselineCommands?: ValidationStageCommands | undefined;
  changedFiles: readonly string[];
}): ValidationAcceptance {
  const exemptStages: ValidationStage[] = [];
  const blockingStages: ValidationStage[] = [];
  for (const result of opts.results) {
    if (result.passed) continue;
    if (
      opts.baselineFailingStages.has(result.stage) &&
      matchesBaselineCommand(result, opts.baselineCommands) &&
      !evidenceNamesChangedFile(result, opts.changedFiles)
    ) {
      exemptStages.push(result.stage);
    } else {
      blockingStages.push(result.stage);
    }
  }
  return { accepted: blockingStages.length === 0, exemptStages, blockingStages };
}
