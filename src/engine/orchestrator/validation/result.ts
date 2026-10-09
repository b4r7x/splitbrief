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
}
