import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageScript } from '../project-meta.js';
import { PYPROJECT_TEST, hasPyprojectSection } from './stacks/python.js';
import { PACKAGE_TEST_COMMAND } from './stacks/typescript.js';

/** The test command a project manifest declares for the planner's `test` checks. */
export type ManifestCommands = { test?: string };

function targetCommand(projectDir: string, manifest: string, runner: string): string | null {
  const path = join(projectDir, manifest);
  if (!existsSync(path)) return null;
  return /^test:/m.test(readFileSync(path, 'utf-8')) ? `${runner} test` : null;
}

export function readManifestCommands(projectDir: string): ManifestCommands {
  const command =
    (packageScript(projectDir, 'test') === null ? null : PACKAGE_TEST_COMMAND) ??
    targetCommand(projectDir, 'Makefile', 'make') ??
    targetCommand(projectDir, 'justfile', 'just') ??
    (hasPyprojectSection(projectDir, PYPROJECT_TEST.section) ? PYPROJECT_TEST.command : null);
  return command === null ? {} : { test: command };
}
