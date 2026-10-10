export interface ValidationResult {
  passed: boolean;
  timedOut?: true | undefined;
  error?: string | undefined;
  output?: string | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
}
