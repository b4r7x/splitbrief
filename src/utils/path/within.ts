import { isAbsolute, relative, sep } from 'node:path';

/** `root` itself or anything under it; `<root>/...` is a name under it, not its parent. */
export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
