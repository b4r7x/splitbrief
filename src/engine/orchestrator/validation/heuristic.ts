import { detectProjectLanguage } from '../../../core/project-meta.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';

export function detectValidationHeuristic(projectDir: string): DiscoveredValidation | null {
  switch (detectProjectLanguage(projectDir)) {
    case 'rust':
      return {
        typecheckCommand: 'cargo check',
        lintCommand: 'cargo clippy --no-deps',
        testCommand: 'cargo test',
        testPattern: '*_test.rs',
        language: 'rust',
      };
    case 'go':
      return {
        typecheckCommand: 'go vet ./...',
        testCommand: 'go test ./...',
        testPattern: '*_test.go',
        language: 'go',
      };
    case 'python':
      return {
        testCommand: 'pytest',
        testPattern: 'test_*.py',
        language: 'python',
      };
    case 'javascript':
      return { testCommand: 'npm test', language: 'javascript' };
    default:
      return null;
  }
}
