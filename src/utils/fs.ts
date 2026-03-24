import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TINY_SPEC_DIR = '.tiny-spec';
const CURRENT_DIR = 'current';
const HISTORY_DIR = 'history';

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

export function archiveCurrentFeature(projectDir: string, featureName: string): void {
  const src = currentDir(projectDir);
  if (!existsSync(src)) return;

  const date = new Date().toISOString().slice(0, 10);
  const dest = join(projectDir, TINY_SPEC_DIR, HISTORY_DIR, `${date}-${featureName}`);
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    renameSync(join(src, entry), join(dest, entry));
  }
}
