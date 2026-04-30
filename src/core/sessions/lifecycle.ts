import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { activeFile, sessionDir, sessionsRoot, STATE_FILE, validateSessionId } from '../paths.js';
import { ensureSessionDir } from '../paths-io.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { writeSecureFile } from '../../lib/fs.js';
import { slugify } from '../../utils/slugify.js';
import { sessionError } from './errors.js';

export function readActive(projectDir: string): string | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim() || null;
}

export function writeActive(projectDir: string, sessionId: string): void {
  validateSessionId(sessionId);
  writeSecureFile(activeFile(projectDir), sessionId + '\n');
}

export function clearActive(projectDir: string): void {
  const p = activeFile(projectDir);
  if (existsSync(p)) unlinkSync(p);
}

export function isSessionLive(projectDir: string, sessionId: string): boolean {
  const stateFile = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(stateFile)) return false;
  try {
    const raw = narrowRecord(JSON.parse(readFileSync(stateFile, 'utf-8')));
    if (!raw || typeof raw.phase !== 'string') return false;
    return raw.phase !== 'complete' && raw.phase !== 'idle';
  } catch {
    return false;
  }
}

const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;

function findUniqueId(projectDir: string, base: string): string {
  const root = sessionsRoot(projectDir);
  if (!existsSync(join(root, base))) return base;
  for (let n = 2; n <= MAX_COLLISION_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
  throw sessionError.idCollision(base, MAX_COLLISION_ATTEMPTS);
}

export function generateSessionId(projectDir: string, feature: string, now: Date = new Date()): string {
  const date = now.toLocaleDateString('sv-SE');
  const slug = slugify(feature).slice(0, MAX_SLUG_LENGTH);
  const base = `${date}-${slug}`;
  return findUniqueId(projectDir, base);
}

export function beginSession(projectDir: string, feature: string): string {
  const sessionId = generateSessionId(projectDir, feature);
  ensureSessionDir(projectDir, sessionId);
  writeActive(projectDir, sessionId);
  return sessionId;
}
