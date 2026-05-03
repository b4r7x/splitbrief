import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';

export function detectValidationHeuristic(projectDir: string): DiscoveredValidation | null {
  if (existsSync(join(projectDir, 'Cargo.toml'))) {
    return {
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      testPattern: '*_test.rs',
      language: 'rust',
    };
  }

  if (existsSync(join(projectDir, 'go.mod'))) {
    return {
      typecheckCommand: 'go vet ./...',
      testCommand: 'go test ./...',
      testPattern: '*_test.go',
      language: 'go',
    };
  }

  if (existsSync(join(projectDir, 'pyproject.toml'))) {
    return {
      testCommand: 'pytest',
      testPattern: 'test_*.py',
      language: 'python',
    };
  }

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript) return null;
      return { testCommand: 'npm test', language: 'javascript' };
    } catch {
      return null;
    }
  }

  return null;
}
