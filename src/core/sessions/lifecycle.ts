import { existsSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeFile,
  sessionDir,
  sessionsRoot,
  STATE_FILE,
  validateSessionId,
  DIPTYCH_DIR,
  SESSIONS_DIR,
} from '../paths.js';
import { ensureSessionDir } from '../paths-io.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { writeSecureFile, fsError } from '../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { slugify } from '../../utils/slugify.js';
import type { SessionRef } from '../types/session-ref.js';
import { sessionError } from './errors.js';
import { findUnusedId } from './find-unused-id.js';

function rejectSymlinkTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

export function readActive(projectDir: string): string | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  try {
    rejectSymlinkTarget(p);
  } catch {
    return null;
  }
  assertExistingPathConfined(`${DIPTYCH_DIR}/active`, projectDir);
  return readFileSync(p, 'utf-8').trim() || null;
}

export function writeActive(ref: SessionRef): void {
  const { projectDir, sessionId } = ref;
  validateSessionId(sessionId);
  assertWritablePathConfined(`${DIPTYCH_DIR}/active`, projectDir);
  writeSecureFile(activeFile(projectDir), sessionId + '\n');
}

export function clearActive(projectDir: string): void {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return;
  try {
    rejectSymlinkTarget(p);
  } catch {
    return;
  }
  assertExistingPathConfined(`${DIPTYCH_DIR}/active`, projectDir);
  unlinkSync(p);
}

export function isSessionLive(ref: SessionRef): boolean {
  const { projectDir, sessionId } = ref;
  const stateFile = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(stateFile)) return false;
  try {
    rejectSymlinkTarget(stateFile);
    assertExistingPathConfined(
      `${DIPTYCH_DIR}/${SESSIONS_DIR}/${sessionId}/${STATE_FILE}`,
      projectDir,
    );
    const raw = narrowRecord(JSON.parse(readFileSync(stateFile, 'utf-8')));
    if (!raw || typeof raw.phase !== 'string') return false;
    return raw.phase !== 'complete' && raw.phase !== 'idle';
  } catch {
    return false;
  }
}

export const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;

function findUniqueId(projectDir: string, base: string): string {
  const root = sessionsRoot(projectDir);
  const id = findUnusedId({
    root,
    base,
    suffixer: (candidateBase, collisionIndex) => `${candidateBase}-${collisionIndex + 1}`,
    maxCollisionAttempts: MAX_COLLISION_ATTEMPTS - 1,
  });
  if (id !== null) return id;
  throw sessionError.idCollision(base, MAX_COLLISION_ATTEMPTS);
}

export function generateSessionId(
  projectDir: string,
  feature: string,
  now: Date = new Date(),
): string {
  const date = now.toLocaleDateString('sv-SE');
  const slug = slugify(feature, MAX_SLUG_LENGTH);
  const base = `${date}-${slug}`;
  return findUniqueId(projectDir, base);
}

export function beginSession(projectDir: string, feature: string): string {
  const sessionId = generateSessionId(projectDir, feature);
  ensureSessionDir(projectDir, sessionId);
  writeActive({ projectDir, sessionId });
  return sessionId;
}
