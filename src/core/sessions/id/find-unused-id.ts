import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function findUnusedId(
  root: string,
  base: string,
  suffixer: (base: string, collisionIndex: number) => string,
  maxCollisionAttempts = 999,
): string | null {
  if (!existsSync(join(root, base))) return base;
  for (let collisionIndex = 1; collisionIndex <= maxCollisionAttempts; collisionIndex++) {
    const candidate = suffixer(base, collisionIndex);
    if (!existsSync(join(root, candidate))) return candidate;
  }
  return null;
}
