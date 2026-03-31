import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from '../types.js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export function getSessionDir(scope: 'project' | 'global', projectDir: string): string {
  if (scope === 'global') {
    return join(homedir(), '.tiny-spec', 'sessions');
  }
  return join(projectDir, '.tiny-spec', 'sessions');
}

export function readSession(filePath: string): Session | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function listSessions(dir: string): Session[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const sessions: Session[] = [];

  for (const file of files) {
    const session = readSession(join(dir, file));
    if (session) sessions.push(session);
  }

  return sessions
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10);
}

export function writeSession(dir: string, session: Session): void {
  mkdirSync(dir, { recursive: true });
  const slug = slugify(session.feature);
  const filename = `${session.startedAt}-${slug}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(session, null, 2), 'utf-8');
}
