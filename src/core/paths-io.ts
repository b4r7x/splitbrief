import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIPTYCH_DIR, SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE, sessionDir } from './paths.js';
import { ensureSecureDir, fsError, SECURE_FILE_MODE } from '../lib/fs.js';
import { validateSafeIdentifier } from '../utils/validate-identifier.js';
import { error, matches } from '../utils/error.js';

export const pathError = {
  escapesProject: (filePath: string) =>
    error('path-escapes-project', `Path '${filePath}' escapes project directory`, { filePath }),
  isEscapesProject: matches('path-escapes-project'),
} as const;

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getDiptychVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readPackageVersion();
  return cachedVersion;
}

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
  writeFileSync(join(sessionDir(projectDir, sessionId), filename), finalContent, { encoding: 'utf-8', mode: SECURE_FILE_MODE });
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
  if (isAbsolute(filePath)) {
    throw pathError.escapesProject(filePath);
  }
  const root = resolve(projectDir);
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw pathError.escapesProject(filePath);
  }
  return resolved;
}

export function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const filePath = validateTaskPath(projectDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
