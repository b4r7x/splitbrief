import type { TokenDelta } from '../schemas/tokens.js';

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  usage?: TokenDelta | undefined;
}

export interface ValidationResult {
  passed: boolean;
  stage: 'tsc' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}
