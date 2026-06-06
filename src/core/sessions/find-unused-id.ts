import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FindUnusedIdInput {
  root: string;
  base: string;
  suffixer: (base: string, collisionIndex: number) => string;
  maxCollisionAttempts?: number;
}

export function findUnusedId(input: FindUnusedIdInput): string | null {
  const { root, base, suffixer, maxCollisionAttempts = 999 } = input;
  if (!existsSync(join(root, base))) return base;
  for (let collisionIndex = 1; collisionIndex <= maxCollisionAttempts; collisionIndex++) {
    const candidate = suffixer(base, collisionIndex);
    if (!existsSync(join(root, candidate))) return candidate;
  }
  return null;
}
