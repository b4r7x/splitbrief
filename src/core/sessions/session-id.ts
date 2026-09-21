import { sessionsRoot } from '../paths.js';
import { slugify } from '../../utils/slugify.js';
import { sessionError } from './errors.js';
import { findUnusedId } from './find-unused-id.js';

export const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;

export interface GenerateSessionIdInput {
  projectDir: string;
  feature: string;
  now?: Date | undefined;
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

export function generateSessionId(input: GenerateSessionIdInput): string {
  const now = input.now ?? new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const slug = slugify(input.feature, MAX_SLUG_LENGTH) || 'unknown';
  return findUniqueId(input.projectDir, `${date}-${slug}`);
}
