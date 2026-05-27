import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageJson } from './project-meta.js';
import { DIPTYCH_DIR, SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE, sessionDir } from './paths.js';
import { ensureSecureDir, fsError, writeSecureFile } from '../lib/fs.js';
import { assertWritablePathConfined } from '../lib/path-confinement.js';
import { validateSafeIdentifier } from '../utils/validate-identifier.js';
import { error, matches } from '../utils/error.js';
import type { WorkflowMode } from './schemas/enums.js';

export const pathError = {
  escapesProject: (filePath: string) =>
    error('path-escapes-project', `Path '${filePath}' escapes project directory`, { filePath }),
  isEscapesProject: matches('path-escapes-project'),
} as const;

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const parsed = readPackageJson(root);
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getDiptychVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readPackageVersion();
  return cachedVersion;
}

export type SpecMetadata = {
  plannerTool: string;
  plannerModel?: string | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
  mode: WorkflowMode;
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
    `generated_by: diptych v${getDiptychVersion()}`,
    plannerLine,
    implementerLine,
    `mode: ${opts.mode}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

export function ensureSessionDir(projectDir: string, sessionId: string): void {
  ensureSecureDir(sessionDir(projectDir, sessionId));
}

export function ensureDiptychDir(projectDir: string): void {
  ensureSecureDir(join(projectDir, DIPTYCH_DIR));
}

export function validateFilename(filename: string): void {
  const result = validateSafeIdentifier(filename);
  if (!result.ok) {
    throw fsError.invalidId('filename', filename, result.reason);
  }
}

export function writeSpecFile(projectDir: string, sessionId: string, filename: string, content: string, metadata?: SpecMetadata | null): void {
  validateFilename(filename);
  ensureSessionDir(projectDir, sessionId);
  let finalContent = content;
  if (metadata && FRONTMATTER_FILES.has(filename) && !content.startsWith('---\n')) {
    finalContent = buildSpecFrontmatter(metadata) + content;
  }
  writeSecureFile(join(sessionDir(projectDir, sessionId), filename), finalContent);
}

export function readSpecFile(projectDir: string, sessionId: string, filename: string): string | null {
  validateFilename(filename);
  const filePath = join(sessionDir(projectDir, sessionId), filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

export function readSpecFileOrEmpty(projectDir: string, sessionId: string, filename: string): string {
  return readSpecFile(projectDir, sessionId, filename) ?? '';
}

export function validateTaskPath(projectDir: string, filePath: string): string {
  try {
    assertWritablePathConfined(filePath, projectDir);
  } catch {
    throw pathError.escapesProject(filePath);
  }
  return resolve(projectDir, filePath);
}

export function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const filePath = validateTaskPath(projectDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
