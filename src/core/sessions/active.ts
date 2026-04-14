import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { activeFile, sessionDir, STATE_FILE } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { writeSecureFile } from '../../utils/fs.js';

export function readActive(projectDir: string): string | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim() || null;
}

export function writeActive(projectDir: string, sessionId: string): void {
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
