import type { ValidationStage } from '../../../core/schemas/enums.js';

export interface ValidationResult {
  passed: boolean;
  stage: ValidationStage;
  skipped?: boolean | undefined;
  error?: string | undefined;
  output?: string | undefined;
  command?: string | undefined;
}
