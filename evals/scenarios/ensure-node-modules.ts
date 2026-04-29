import { existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootNodeModules = resolve(import.meta.dirname, '../../node_modules');

export function ensureNodeModules(dir: string): void {
  const fixtureNodeModules = join(dir, 'node_modules');
  if (!existsSync(fixtureNodeModules) && existsSync(rootNodeModules)) {
    symlinkSync(rootNodeModules, fixtureNodeModules, 'dir');
  }
}
