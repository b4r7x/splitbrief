// Sync FS ops are intentional here: called only at phase transitions (spec/plan/task writes),
// not during per-task implementation hot paths.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { TINY_SPEC_DIR, CURRENT_DIR } from './paths.js';

export function currentDir(projectDir: string): string {
  return join(projectDir, TINY_SPEC_DIR, CURRENT_DIR);
}

export function ensureTinySpecDir(projectDir: string): void {
  mkdirSync(currentDir(projectDir), { recursive: true });
}

export function writeSpecFile(projectDir: string, filename: string, content: string): void {
  ensureTinySpecDir(projectDir);
  writeFileSync(join(currentDir(projectDir), filename), content, 'utf-8');
}

export function readSpecFile(projectDir: string, filename: string): string | null {
  const filePath = join(currentDir(projectDir), filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

export function readSpecFileOrEmpty(projectDir: string, filename: string): string {
  return readSpecFile(projectDir, filename) ?? '';
}

export function validateTaskPath(projectDir: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error(`Path '${filePath}' escapes project directory`);
  }
  const resolved = resolve(join(projectDir, filePath));
  if (!resolved.startsWith(resolve(projectDir))) {
    throw new Error(`Path '${filePath}' escapes project directory`);
  }
  return resolved;
}

export function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const filePath = validateTaskPath(projectDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
