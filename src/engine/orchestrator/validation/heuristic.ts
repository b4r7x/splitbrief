import { detectProjectLanguage } from '../../../core/project-meta.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { detectLintCommand } from '../../../core/validation/lint-detection.js';

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
    case 'javascript': {
      const lintCommand = detectLintCommand(projectDir);
      return {
        testCommand: 'npm test',
        ...(lintCommand === null ? {} : { lintCommand }),
        language: 'javascript',
      };
    }
    // TypeScript keeps its typecheck and test defaults (`npx tsc --noEmit`,
    // `npm test` with per-task test targeting), which only apply while the
    // heuristic leaves those fields unset; lint has no default, so without this
    // case a `validation.lint: true` TS project silently never lints.
    case 'typescript': {
      const lintCommand = detectLintCommand(projectDir);
      return lintCommand === null ? null : { lintCommand, language: 'typescript' };
    }
    default:
      return null;
  }
}
