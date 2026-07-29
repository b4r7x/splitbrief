import { join, resolve } from 'node:path';
import { readPackageJson } from './project-meta.js';
import {
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
  validateSessionId,
} from './paths.js';
import { fsError } from '../lib/fs.js';
import {
  confinedEnsureDir,
  confinedExists,
  confinedReadFile,
  confinedWriteFile,
} from '../lib/confined-fs.js';
import { assertPathConfined, assertModelWritablePathConfined } from '../lib/path-confinement.js';
import { validateSafeIdentifier } from '../utils/validate-identifier.js';
import { nowIso } from '../utils/format-time.js';
import { error, matches } from '../utils/error.js';
import type { WorkflowMode } from './schemas/enums.js';

export const pathError = {
  escapesProject: (filePath: string, cause?: unknown) =>
    error(
      'path-escapes-project',
      `Path '${filePath}' escapes project directory`,
      { filePath },
      cause,
    ),
  isEscapesProject: matches('path-escapes-project'),
} as const;

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  try {
    const root = join(import.meta.dirname, '..', '..');
    const parsed = readPackageJson(root);
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getSplitbriefVersion(): string {
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

function hasFileFrontmatter(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return match?.[1]?.includes('generated_by:') ?? false;
}

export function buildSpecFrontmatter(opts: SpecMetadata): string {
  const plannerLine = opts.plannerModel
    ? `planner: ${opts.plannerTool} (${opts.plannerModel})`
    : `planner: ${opts.plannerTool}`;
  const implementerLine = opts.implementerModel
    ? `implementer: ${opts.implementerTool} (${opts.implementerModel})`
    : `implementer: ${opts.implementerTool}`;
  const lines = [
    '---',
    `generated_by: splitbrief v${getSplitbriefVersion()}`,
    plannerLine,
    implementerLine,
    `mode: ${opts.mode}`,
    `created_at: ${nowIso()}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

export function ensureSessionDir(projectDir: string, sessionId: string): void {
  validateSessionId(sessionId);
  confinedEnsureDir(projectDir, join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId));
}

export function ensureSplitbriefDir(projectDir: string): void {
  confinedEnsureDir(projectDir, SPLITBRIEF_DIR);
}

export function validateFilename(filename: string): void {
  const result = validateSafeIdentifier(filename);
  if (!result.ok) {
    throw fsError.invalidId('filename', filename, result.reason);
  }
}

export interface SpecFileRef {
  projectDir: string;
  sessionId: string;
}

export function writeSpecFile(
  ref: SpecFileRef,
  filename: string,
  content: string,
  metadata?: SpecMetadata | null,
): void {
  validateFilename(filename);
  ensureSessionDir(ref.projectDir, ref.sessionId);
  let finalContent = content;
  if (metadata && FRONTMATTER_FILES.has(filename) && !hasFileFrontmatter(content)) {
    finalContent = buildSpecFrontmatter(metadata) + content;
  }
  confinedWriteFile(ref.projectDir, specFileRelativePath(ref.sessionId, filename), finalContent);
}

function specFileRelativePath(sessionId: string, filename: string): string {
  validateSessionId(sessionId);
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, filename);
}

export function readSpecFile(ref: SpecFileRef, filename: string): string | null {
  validateFilename(filename);
  const relativePath = specFileRelativePath(ref.sessionId, filename);
  assertPathConfined(relativePath, ref.projectDir);
  if (!confinedExists(ref.projectDir, relativePath)) return null;
  return confinedReadFile(ref.projectDir, relativePath);
}

export function readSpecFileOrEmpty(ref: SpecFileRef, filename: string): string {
  return readSpecFile(ref, filename) ?? '';
}

export function validateTaskPath(projectDir: string, filePath: string): string {
  try {
    assertModelWritablePathConfined(filePath, projectDir);
  } catch (err) {
    throw pathError.escapesProject(filePath, err);
  }
  return resolve(projectDir, filePath);
}

export function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  validateTaskPath(projectDir, relPath);
  confinedWriteFile(projectDir, relPath, content);
}
