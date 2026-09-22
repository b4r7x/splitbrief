import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packageScript } from '../project-meta.js';

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

const PRETTIER_CONFIG_FILE = /^(\.prettierrc|prettier\.config\.)/;

const RECOGNIZED_LINT_SCRIPT =
  /\b(eslint|biome|oxlint|tslint|stylelint|prettier|knip|ruff|flake8|pylint|golangci-lint|clippy)\b/i;

// Validation runs after promotion, in the real project. A rewriting linter
// (`eslint . --fix`, `biome check --write .`) would mutate files no Task Brief
// targeted, and those mutations then reach change detection unattributed. Only an
// explicit `validation.lintCommand` opts into that.
const WRITING_LINT_SCRIPT = /(^|\s)--(fix|write|apply)\b/i;

function hasRecognizedLintScript(projectDir: string): string | null {
  const lint = packageScript(projectDir, 'lint');
  if (lint === null) return null;
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

// The lint stage formats the brief's changed files with the project's own
// formatter before it runs, so a layout-only lint failure never costs an
// attempt; only those files are rewritten, so attribution holds. ESLint
// `--fix` rewrites semantics as well as layout and is never run.
export function detectFormatFixCommand(projectDir: string): string | null {
  if (BIOME_CONFIG_FILES.some((file) => existsSync(join(projectDir, file)))) {
    return 'npx biome format --write';
  }
  // A project directory that is not there has no formatter, the way it has no linter.
  if (!existsSync(projectDir)) return null;
  if (readdirSync(projectDir).some((entry) => PRETTIER_CONFIG_FILE.test(entry))) {
    return 'npx prettier --write';
  }
  return null;
}
