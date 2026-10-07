import type { ValidationStage } from '../../../core/schemas/enums.js';

import type { FailingTest } from './test-failures.js';

export interface ValidationResult {
  passed: boolean;
  stage: ValidationStage;
  timedOut?: true | undefined;
  skipped?: boolean | undefined;
  skippedReason?: string | undefined;
  error?: string | undefined;
  output?: string | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
  failingTests?: readonly FailingTest[] | undefined;
  failureFiles?: readonly string[] | undefined;
  /** This result's failure keys that the same command also showed at the run base. Absent when the base was not asked or showed none of them. */
  preExisting?: readonly string[] | undefined;
}
