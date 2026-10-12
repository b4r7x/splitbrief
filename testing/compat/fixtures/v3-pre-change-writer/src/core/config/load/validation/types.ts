import type { Config } from '../../../schemas/config.js';
import type { ReadinessDiagnosticStateId } from '../../../schemas/readiness.js';

export interface ConfigError {
  path: string;
  message: string;
  /** Stable failure family for readiness diagnostics, when validation knows it. */
  diagnosticState?: ReadinessDiagnosticStateId | undefined;
}

export interface ConfigValidation {
  errors: ConfigError[];
  warnings: string[];
  data?: Config | undefined;
}
