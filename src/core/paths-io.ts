import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TINY_SPEC_DIR, CURRENT_DIR, SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from './paths.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../utils/fs.js';

const TINY_SPEC_VERSION: string = (() => {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

export type SpecMetadata = {
  plannerTool: string;
  plannerModel?: string | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
  mode: string;
};

let activeMetadata: SpecMetadata | null = null;

export function setSpecMetadata(meta: SpecMetadata | null): void {
  activeMetadata = meta;
}

export function getSpecMetadata(): SpecMetadata | null {
  return activeMetadata;
}

export function resetSpecMetadata(): void {
  activeMetadata = null;
}

const FRONTMATTER_FILES = new Set([SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE]);

export function buildSpecFrontmatter(opts: SpecMetadata): string {
  const plannerLine = opts.plannerModel
    ? `planner: ${opts.plannerTool} (${opts.plannerModel})`
    : `planner: ${opts.plannerTool}`;
  const implementerLine = opts.implementerModel
    ? `implementer: ${opts.implementerTool} (${opts.implementerModel})`
    : `implementer: ${opts.implementerTool}`;
  const lines = [
    '---',
    `generated_by: tiny-spec v${TINY_SPEC_VERSION}`,
    plannerLine,
    implementerLine,
    `mode: ${opts.mode}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

export function currentDir(projectDir: string): string {
  return join(projectDir, TINY_SPEC_DIR, CURRENT_DIR);
}

export function ensureTinySpecDir(projectDir: string): void {
  mkdirSync(currentDir(projectDir), { recursive: true, mode: SECURE_DIR_MODE });
}

export function validateFilename(filename: string): void {
  if (!filename?.trim()) {
    throw new Error(`Invalid filename '${filename}'`);
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Invalid filename '${filename}': must not contain '..', '/' or '\\'`);
  }
}

export function writeSpecFile(projectDir: string, filename: string, content: string): void {
  validateFilename(filename);
  ensureTinySpecDir(projectDir);
  let finalContent = content;
  if (activeMetadata && FRONTMATTER_FILES.has(filename) && !content.startsWith('---\n')) {
    finalContent = buildSpecFrontmatter(activeMetadata) + content;
  }
  writeFileSync(join(currentDir(projectDir), filename), finalContent, { encoding: 'utf-8', mode: SECURE_FILE_MODE });
}

export function readSpecFile(projectDir: string, filename: string): string | null {
  validateFilename(filename);
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
