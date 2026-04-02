import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const TINY_SPEC_DIR = '.tiny-spec';
const CURRENT_DIR = 'current';

function currentDir(projectDir: string): string {
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

export function readFileOrEmpty(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}
