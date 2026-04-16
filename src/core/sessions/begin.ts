import { generateSessionId } from './id.js';
import { ensureSessionDir } from '../paths-io.js';
import { writeActive } from './active.js';

export function beginSession(projectDir: string, feature: string): string {
  const sessionId = generateSessionId(projectDir, feature);
  ensureSessionDir(projectDir, sessionId);
  writeActive(projectDir, sessionId);
  return sessionId;
}
