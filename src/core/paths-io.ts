import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TINY_SPEC_DIR, CURRENT_DIR, SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from './paths.js';
import { ensureSecureDir, validateSafeIdentifier, SECURE_FILE_MODE } from '../utils/fs.js';

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
  ensureSecureDir(currentDir(projectDir));
}

export function validateFilename(filename: string): void {
  validateSafeIdentifier(filename, 'filename');
}

export function writeSpecFile(projectDir: string, filename: string, content: string, metadata?: SpecMetadata | null): void {
  validateFilename(filename);
  ensureTinySpecDir(projectDir);
  let finalContent = content;
  if (metadata && FRONTMATTER_FILES.has(filename) && !content.startsWith('---\n')) {
    finalContent = buildSpecFrontmatter(metadata) + content;
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
  const root = resolve(projectDir);
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path '${filePath}' escapes project directory`);
  }
  return resolved;
}

export function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const filePath = validateTaskPath(projectDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
