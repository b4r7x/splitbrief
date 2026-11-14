import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  confinedEnsureDir,
  confinedWriteFile,
  confinedExists,
  confinedReadFile,
} from '../../lib/fs/confined.js';
import { assertPathConfined } from '../../lib/fs/confinement.js';
import { fsError } from '../../lib/fs/secure.js';
import { fileErrorReason } from '../../utils/format/errors.js';
import { nowIso } from '../../utils/format/time.js';
import { validateSafeIdentifier } from '../../utils/validate-identifier.js';
import {
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
  validateSessionId,
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
} from '../paths.js';
import { getSplitbriefVersion } from '../version.js';
import { sessionError } from './errors.js';

/** Catalog seat identities for document frontmatter. */
export type SpecMetadata = {
  planner: string;
  implementer: string;
  reviewer: string;
};

const FRONTMATTER_FILES = new Set([SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE]);

/** The frontmatter that SPLITBRIEF wrote at the head of `content`; empty when it has none. */
function fileFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return match?.[1]?.includes('generated_by:') === true ? match[0] : '';
}

export function buildSpecFrontmatter(opts: SpecMetadata): string {
  const lines = [
    '---',
    `generated_by: splitbrief v${getSplitbriefVersion()}`,
    `planner: ${stringify(opts.planner, { lineWidth: 0 }).trimEnd()}`,
    `implementer: ${stringify(opts.implementer, { lineWidth: 0 }).trimEnd()}`,
    `reviewer: ${stringify(opts.reviewer, { lineWidth: 0 }).trimEnd()}`,
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
  if (metadata && FRONTMATTER_FILES.has(filename) && fileFrontmatter(content) === '') {
    finalContent = buildSpecFrontmatter(metadata) + content;
  }
  const relativePath = specFileRelativePath(ref.sessionId, filename);
  try {
    confinedWriteFile(ref.projectDir, relativePath, finalContent);
  } catch (cause) {
    if (fileErrorReason(cause) === undefined) throw cause;
    throw sessionError.fileNotSaved(relativePath, cause);
  }
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

/**
 * Replaces the content of a file and keeps the frontmatter that the file has on disk, for a
 * writer that holds no seat identities.
 */
export function rewriteSpecFile(ref: SpecFileRef, filename: string, content: string): void {
  writeSpecFile(ref, filename, fileFrontmatter(readSpecFileOrEmpty(ref, filename)) + content);
}
