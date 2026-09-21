import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageScript } from '../project-meta.js';
import { VALIDATION_STAGES, type ValidationStage } from '../schemas/enums.js';
import { PYPROJECT_SECTIONS, hasPyprojectSection } from './stacks/python.js';
import { packageScriptCommand } from './stacks/typescript.js';

export type ManifestCommands = Partial<Record<ValidationStage, string>>;

function manifestScriptCommand(projectDir: string, stage: ValidationStage): string | null {
  if (packageScript(projectDir, stage) === null) return null;
  return packageScriptCommand(stage);
}

function targetCommand(
  projectDir: string,
  manifest: string,
  runner: string,
  stage: ValidationStage,
): string | null {
  const path = join(projectDir, manifest);
  if (!existsSync(path)) return null;
  const hasTarget = new RegExp(`^${stage}:`, 'm').test(readFileSync(path, 'utf-8'));
  return hasTarget ? `${runner} ${stage}` : null;
}

function pyprojectCommand(projectDir: string, stage: ValidationStage): string | null {
  const { section, command } = PYPROJECT_SECTIONS[stage];
  return hasPyprojectSection(projectDir, section) ? command : null;
}

export function readManifestCommands(projectDir: string): ManifestCommands {
  const commands: ManifestCommands = {};
  for (const stage of VALIDATION_STAGES) {
    const command =
      manifestScriptCommand(projectDir, stage) ??
      targetCommand(projectDir, 'Makefile', 'make', stage) ??
      targetCommand(projectDir, 'justfile', 'just', stage) ??
      pyprojectCommand(projectDir, stage);
    if (command !== null) commands[stage] = command;
  }
  return commands;
}
