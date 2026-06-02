export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}
