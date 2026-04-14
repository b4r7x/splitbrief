import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsRoot } from '../paths.js';

const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function findUniqueId(projectDir: string, base: string): string {
  const root = sessionsRoot(projectDir);
  if (!existsSync(join(root, base))) return base;
  for (let n = 2; n <= MAX_COLLISION_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
  throw new Error(`Could not generate unique session-id from base '${base}': all suffixes up to ${MAX_COLLISION_ATTEMPTS} are taken`);
}

export function generateSessionId(projectDir: string, feature: string, now: Date = new Date()): string {
  const date = now.toLocaleDateString('sv-SE');
  const slug = slugify(feature).slice(0, MAX_SLUG_LENGTH);
  const base = `${date}-${slug}`;
  return findUniqueId(projectDir, base);
}
