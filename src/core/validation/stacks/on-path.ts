import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function isOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env['PATH'];
  if (path === undefined || path === '') return false;
  return path.split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, name)));
}
