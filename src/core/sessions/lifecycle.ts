import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeFile,
  sessionDir,
  sessionsRoot,
  STATE_FILE,
  validateSessionId,
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
} from '../paths.js';
import { ensureSessionDir } from '../paths-io.js';
import { isTerminalPhase } from '../phases.js';
import { PhaseSchema, type Phase } from '../schemas/enums.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { writeSecureFile, rejectSymlinkTarget } from '../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { slugify } from '../../utils/slugify.js';
import type { SessionRef } from '../types/session-ref.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
import { sessionError } from './errors.js';
import { findUnusedId } from './find-unused-id.js';
import { checkSessionLockStatus } from './lockfile-status.js';

export function readActive(projectDir: string): string | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  try {
    rejectSymlinkTarget(p);
  } catch {
    return null;
  }
  assertExistingPathConfined(`${SPLITBRIEF_DIR}/active`, projectDir);
  return readFileSync(p, 'utf-8').trim() || null;
}

export function writeActive(ref: SessionRef): void {
  const { projectDir, sessionId } = ref;
  validateSessionId(sessionId);
  assertWritablePathConfined(`${SPLITBRIEF_DIR}/active`, projectDir);
  writeSecureFile(activeFile(projectDir), sessionId + '\n');
}

export function clearActive(ref: SessionRef): void {
  const { projectDir, sessionId } = ref;
  if (readActive(projectDir) !== sessionId) return;
  const p = activeFile(projectDir);
  assertExistingPathConfined(`${SPLITBRIEF_DIR}/active`, projectDir);
  unlinkSync(p);
}

function readSessionPhase(ref: SessionRef): Phase | null {
  const { projectDir, sessionId } = ref;
  const stateFile = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(stateFile)) return null;
  try {
    rejectSymlinkTarget(stateFile);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/${STATE_FILE}`,
      projectDir,
    );
    const raw = narrowRecord(JSON.parse(readFileSync(stateFile, 'utf-8')));
    if (!raw || typeof raw.phase !== 'string') return null;
    const parsed = PhaseSchema.safeParse(raw.phase);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isSessionLive(ref: SessionRef): boolean {
  const phase = readSessionPhase(ref);
  if (phase === null || isTerminalPhase(phase)) return false;

  const lock = checkSessionLockStatus({
    sessionDir: sessionDir(ref.projectDir, ref.sessionId),
    expectedSessionId: ref.sessionId,
  });
  switch (lock.kind) {
    case 'missing':
    case 'invalid':
    case 'exited':
    case 'dead':
    case 'stale':
      return false;
    case 'live':
      return true;
  }
}

export const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;
const OPAQUE_ID_LENGTH = 12;
const OPAQUE_SESSION_PATTERN = /^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}(?:-\d+)?$/;
export const TRANSCRIPT_OMITTED_FEATURE = TRANSCRIPT_OMITTED_MESSAGE;

export interface SessionIdOptions {
  persistTranscript?: boolean | undefined;
}

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
  opts: SessionIdOptions = {},
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  if (opts.persistTranscript === false) {
    return findUniqueId(projectDir, `${date}-${generateOpaqueSessionSlug()}`);
  }
  const slug = slugify(feature, MAX_SLUG_LENGTH) || 'unknown';
  const base = `${date}-${slug}`;
  return findUniqueId(projectDir, base);
}

export function generateOpaqueSessionSlug(): string {
  return `session-${randomUUID().replaceAll('-', '').slice(0, OPAQUE_ID_LENGTH)}`;
}

export function isOpaqueSessionId(sessionId: string): boolean {
  return OPAQUE_SESSION_PATTERN.test(sessionId);
}

export function featureForTranscriptPolicy(feature: string, persistTranscript: boolean): string {
  return persistTranscript ? feature : TRANSCRIPT_OMITTED_FEATURE;
}

export function beginSession(
  projectDir: string,
  feature: string,
  opts: SessionIdOptions = {},
): string {
  const sessionId = generateSessionId(projectDir, feature, new Date(), opts);
  ensureSessionDir(projectDir, sessionId);
  writeActive({ projectDir, sessionId });
  return sessionId;
}
