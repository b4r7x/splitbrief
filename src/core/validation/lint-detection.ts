import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';

const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

const BIOME_CONFIG_FILES = ['biome.json', 'biome.jsonc'];

const RECOGNIZED_LINT_SCRIPT =
  /\b(eslint|biome|oxlint|tslint|stylelint|prettier|knip|ruff|flake8|pylint|golangci-lint|clippy)\b/i;

// Validation runs after promotion, in the real project. A rewriting linter
// (`eslint . --fix`, `biome check --write .`) would mutate files no Task Brief
// targeted, and those mutations then reach change detection unattributed. Only an
// explicit `validation.lintCommand` opts into that.
const WRITING_LINT_SCRIPT = /(^|\s)--(fix|write|apply)\b/i;

function hasRecognizedLintScript(projectDir: string): string | null {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return null;
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return null;
  const lint = scripts['lint'];
  if (typeof lint !== 'string' || lint.trim() === '') return null;
  if (!RECOGNIZED_LINT_SCRIPT.test(lint)) return null;
  if (WRITING_LINT_SCRIPT.test(lint)) return null;
  return 'npm run lint';
}

// The single source for JavaScript/TypeScript lint auto-discovery: the readiness
// report and the validation heuristic must agree on when a lint command exists,
// or readiness claims a stage the engine then silently skips. A read-only `lint`
// package script wins over linter config files; arbitrary scripts (for example
// `echo lint-ok`) and rewriting ones fall through to ESLint/Biome config detection.
export function detectLintCommand(projectDir: string): string | null {
  const packageLint = hasRecognizedLintScript(projectDir);
  if (packageLint !== null) return packageLint;
  if (ESLINT_CONFIG_FILES.some((file) => existsSync(join(projectDir, file)))) {
    return 'npx eslint .';
  }
  if (BIOME_CONFIG_FILES.some((file) => existsSync(join(projectDir, file)))) {
    return 'npx biome check .';
  }
  return null;
}
