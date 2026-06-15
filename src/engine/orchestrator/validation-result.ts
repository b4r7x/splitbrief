export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  skipped?: boolean | undefined;
  error?: string | undefined;
  output?: string | undefined;
}
